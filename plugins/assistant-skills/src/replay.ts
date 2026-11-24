import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { executeSingleTool } from './tool-batch.js'
import * as FileTools from '@deepseek-ai/dsh-tool-fs'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import {
  assertDefinitionProtocolFamilies,
  compensationDirective,
  fileObservationSteps,
  instantiate,
  validateStepGraph,
  type SkillDefinition,
  type SkillStep,
} from './definition.js'
import { inspectApplyPatchValue, isNonMutatingStep, type AssistantRecoveryCompensationPort } from './compensation.js'
import { extractPatchAffectedPaths, rewritePatchHeaderPaths } from './patch-paths.js'

export type ReplayDomainToolHandler = (
  args: Readonly<Record<string, unknown>>,
  context: { readonly root: string; readonly workspace: string; readonly signal: AbortSignal },
) => Promise<unknown> | unknown

export interface ReplayDomainToolPolicy {
  readonly mutating?: boolean
}

export interface ReplayToolAdapter {
  readonly mutating?: boolean
  readonly handler: ReplayDomainToolHandler
}

export interface ValidateReplayTraceOptions {
  readonly domainTools?: Readonly<Record<string, ReplayDomainToolPolicy>>
}

export interface ReplayInput {
  definition: SkillDefinition
  inputs: Readonly<Record<string, unknown>>
  files: readonly { path: string; content: string }[]
  artifactPath: string
  stateRoot: string
  maxToolCalls: number
  maxBytes: number
  signal: AbortSignal
  authorize: () => void
  domainToolHandlers?: Readonly<Record<string, ReplayDomainToolHandler | ReplayToolAdapter>>
  compensationPort?: AssistantRecoveryCompensationPort
}

export type ReplayStep =
  | { id: string; toolName: string; outcome: 'executed'; resultDigest: string }
  | { id: string; toolName: 'glob' | 'grep' | 'get_goal'; outcome: 'omitted-observation'; observation: 'provenance-only' }

export interface ReplayResult {
  artifact: string
  toolCalls: number
  executedToolCalls: number
  omittedObservations: number
  steps: readonly ReplayStep[]
  quiescent: true
}

const NATIVE_REPLAY_FS_TOOLS = new Set(['read', 'write', 'edit', 'apply_patch'])

export const SUPPORTED_REPLAY_DOMAIN_TOOLS = new Set([
  // Read / inspection tools
  'wiki_search',
  'wiki_read',
  'wiki_lint',
  'action_github_inspect',
  'action_calendar_action',
  'action_broker_grants',
  'isolation_grants',
  'work_item_list',
  'work_item_read_context',
  'work_item_read_source',
  'work_item_status',
  'memory_search',
  'memory_read_evidence',
  // Mutating domain tools (executed only via bounded offline ReplayInput handlers)
  'wiki_upsert',
  'action_lark_action',
  'action_http_request',
  'action_github_branch',
  'action_github_commit',
  'isolation_run',
])

const MUTATING_REPLAY_DOMAIN_TOOLS = new Set([
  'wiki_upsert',
  'action_lark_action',
  'action_http_request',
  'action_github_branch',
  'action_github_commit',
  'isolation_run',
])

function isReplayControlTool(name: string, arguments_: unknown): boolean {
  const normalized = name.toLowerCase()
  if (normalized === 'get_goal') {
    return !arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)
      || Object.getPrototypeOf(arguments_) !== Object.prototype
      || Object.getOwnPropertySymbols(arguments_).length !== 0
      || Object.keys(arguments_).length !== 0
  }
  return normalized.startsWith('goal_')
    || normalized.startsWith('skill')
    || normalized.includes('workflow')
    || normalized.includes('subagent')
    || ['create_goal', 'update_goal', 'run_code', 'javascript', 'bash', 'action_shell_exec'].includes(normalized)
}

const fail = (message: string): never => { throw new Error(`assistant-skills: replay ${message}`) }
const bytes = (value: string) => Buffer.byteLength(value, 'utf8')
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    && Object.getOwnPropertySymbols(value).length === 0 && Object.keys(value).every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor !== undefined && 'value' in descriptor
    })
}
function text(value: unknown, maximum = 256): value is string { return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\\\p{Cc}]/u.test(value) }
function stepId(value: unknown): value is string { return text(value) }
function pathIn(path: unknown, workspace: string, root: string): string {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.includes('\\')) fail('invalid path')
  const raw = path as string
  let value: string
  if (isAbsolute(raw)) { const part = relative(workspace, raw); if (part === '' || part.startsWith(`..${sep}`) || part === '..' || isAbsolute(part)) fail('external path'); value = part } else value = raw
  if (value.split('/').some(part => !part || part === '.' || part === '..')) fail('invalid path')
  const output = resolve(root, value)
  if (!output.startsWith(`${root}${sep}`)) fail('external path')
  return output
}
function sourcePath(path: unknown, workspace: string): void {
  if (!text(path, 4096)) fail('invalid observation path')
  const raw = path as string
  if (raw.split('/').some(part => part === '.' || part === '..' || !isAbsolute(raw) && part === '')) fail('invalid observation path')
  const resolved = resolve(workspace, raw)
  const part = relative(workspace, resolved)
  if (part.startsWith(`..${sep}`) || part === '..' || isAbsolute(part)) fail('external observation path')
}
function relativePattern(value: unknown, field: string): void {
  if (!text(value, 4096) || isAbsolute(value as string) || (value as string).split('/').some(part => part === '' || part === '.' || part === '..')) fail(`invalid ${field}`)
}
function checkedObservation(step: { id: string; toolName: string; arguments: unknown }, workspace: string): ReplayStep | undefined {
  if (step.toolName === 'get_goal') {
    if (!record(step.arguments) || Object.keys(step.arguments).length !== 0) fail('invalid get_goal observation')
    return { id: step.id, toolName: 'get_goal', outcome: 'omitted-observation', observation: 'provenance-only' }
  }
  if (step.toolName !== 'glob' && step.toolName !== 'grep') return undefined
  if (!record(step.arguments)) fail('invalid observation arguments')
  const args = step.arguments as Record<string, unknown>; const allowed = step.toolName === 'glob' ? ['path', 'pattern'] : ['path', 'pattern', 'include']
  if (Object.keys(args).some(key => !allowed.includes(key)) || !Object.hasOwn(args, 'pattern') || !text(args.pattern, 4096)) fail('invalid observation arguments')
  if (Object.hasOwn(args, 'path')) sourcePath(args.path, workspace)
  if (step.toolName === 'glob') relativePattern(args.pattern, 'glob pattern')
  if (step.toolName === 'grep' && Object.hasOwn(args, 'include')) relativePattern(args.include, 'grep include')
  return { id: step.id, toolName: step.toolName, outcome: 'omitted-observation', observation: 'provenance-only' }
}
function checkedDomainToolsOption(domainTools?: Readonly<Record<string, ReplayDomainToolPolicy>>): ReadonlyMap<string, ReplayDomainToolPolicy> {
  const allowed = new Map<string, ReplayDomainToolPolicy>()
  if (domainTools === undefined) return allowed
  if (!record(domainTools)) fail('invalid domain tools configuration')
  for (const [toolName, policy] of Object.entries(domainTools)) {
    if (!SUPPORTED_REPLAY_DOMAIN_TOOLS.has(toolName) || NATIVE_REPLAY_FS_TOOLS.has(toolName) || isReplayControlTool(toolName, {})) {
      fail('invalid tool')
    }
    if (!record(policy) || (policy.mutating !== undefined && typeof policy.mutating !== 'boolean')) fail('invalid domain tool policy')
    allowed.set(toolName, { mutating: typeof policy.mutating === 'boolean' ? policy.mutating : MUTATING_REPLAY_DOMAIN_TOOLS.has(toolName) })
  }
  return allowed
}
function checkedStep(
  step: { toolName: string; arguments: unknown },
  workspace: string,
  root: string,
  domainTools: ReadonlyMap<string, ReplayDomainToolPolicy>,
): Record<string, unknown> {
  if (!record(step.arguments)) fail('invalid tool arguments')
  const args = step.arguments as Record<string, unknown>
  if (step.toolName === 'apply_patch') {
    if (Object.keys(args).length !== 1 || typeof args.input !== 'string' || args.input.length === 0) fail('invalid apply_patch arguments')
    const patchText = args.input as string
    try {
      const rewritten = rewritePatchHeaderPaths(patchText, rawPath => {
        const contained = pathIn(rawPath, workspace, root)
        return relative(root, contained)
      })
      return { input: rewritten }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('assistant-skills: replay ')) throw error
      return fail('invalid apply_patch input')
    }
  }
  if (['read', 'write', 'edit'].includes(step.toolName)) {
    const allowed = step.toolName === 'read'
      ? ['file_path', 'offset', 'limit']
      : step.toolName === 'write'
        ? ['file_path', 'content']
        : ['file_path', 'old_string', 'new_string', 'replace_all']
    if (Object.keys(args).some(key => !allowed.includes(key)) || typeof args.file_path !== 'string') fail('invalid tool arguments')
    if (step.toolName === 'write' && typeof args.content !== 'string' || step.toolName === 'edit' && (typeof args.old_string !== 'string' || typeof args.new_string !== 'string' || typeof args.replace_all !== 'undefined' && typeof args.replace_all !== 'boolean')) fail('invalid tool arguments')
    if (step.toolName === 'read' && (args.offset !== undefined && (typeof args.offset !== 'number' || !Number.isSafeInteger(args.offset) || args.offset < 1) || args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isSafeInteger(args.limit) || args.limit < 1))) fail('invalid tool arguments')
    return { ...args, file_path: pathIn(args.file_path, workspace, root) }
  }
  if (domainTools.has(step.toolName) && !isReplayControlTool(step.toolName, step.arguments)) {
    return JSON.parse(JSON.stringify(args)) as Record<string, unknown>
  }
  return fail('invalid tool')
}
type ReplayDispatchStep = SkillStep & { observationAllowsAbsent?: boolean }
function dispatchSteps(definition: SkillDefinition): readonly ReplayDispatchStep[] {
  const observations = new Map(fileObservationSteps(definition).map(value => [value.beforeStepId, value]))
  return definition.steps.flatMap(step => {
    const observation = observations.get(step.id)
    return observation ? [
      { id: observation.id, toolName: 'read', arguments: { file_path: observation.filePath, limit: 1 }, dependsOn: [], observationAllowsAbsent: observation.allowAbsent },
      step,
    ] : [step]
  })
}

async function assertNoSymlinkForPath(
  root: string,
  targetPath: string,
  options?: { readonly allowNonDirectoryParent?: boolean },
): Promise<void> {
  const rel = relative(root, targetPath)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('external path')
  let cursor = root
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment)
    try {
      const stat = await lstat(cursor)
      if (stat.isSymbolicLink()) fail('symlink detected')
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code === 'ENOENT' || (options?.allowNonDirectoryParent === true && code === 'ENOTDIR')) break
      throw error
    }
  }
}

/** Validate the fixed captured trace without granting its observations executable authority. */
export function validateReplayTrace(
  definition: SkillDefinition,
  maxToolCalls: number,
  maxBytes: number,
  options?: ValidateReplayTraceOptions,
): readonly ReplayStep[] {
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || !definition || !Array.isArray(definition.steps)
    || definition.steps.length > 32 || definition.steps.length > maxToolCalls || typeof definition.source?.scope?.workspace !== 'string' || !isAbsolute(definition.source.scope.workspace)) fail('invalid trace')
  const domainTools = checkedDomainToolsOption(options?.domainTools)
  assertDefinitionProtocolFamilies(definition)
  const expanded = dispatchSteps(definition)
  if (expanded.length > 32 || expanded.length > maxToolCalls) fail('tool-call limit')
  const ids = new Set<string>(); let parameterBytes = 0
  const trace = expanded.map(step => {
    if (!record(step) || !stepId(step.id) || !text(step.toolName) || !record(step.arguments) || ids.has(step.id)) fail('invalid trace')
    ids.add(step.id); parameterBytes += bytes(JSON.stringify(step.arguments))
    if (parameterBytes > maxBytes) fail('byte limit')
    const observation = checkedObservation(step as { id: string; toolName: string; arguments: unknown }, definition.source.scope.workspace)
    if (observation !== undefined) return observation
    if (isReplayControlTool(step.toolName, step.arguments)) fail('invalid tool')
    if (!NATIVE_REPLAY_FS_TOOLS.has(step.toolName) && !domainTools.has(step.toolName)) fail('invalid tool')
    // Validate the original source-workspace path shape without using it or
    // granting the step access to this synthetic validation root.
    checkedStep(step, definition.source.scope.workspace, '/assistant-skills-validation', domainTools)
    return { id: step.id, toolName: step.toolName, outcome: 'executed' } as ReplayStep
  })
  // Graph well-formedness is checked after per-step shape validation so a
  // malformed/forged step surfaces its specific defect rather than the generic
  // graph error; the expanded array (provenance nodes included) is the real graph.
  validateStepGraph(expanded)
  if (definition.compensationPlan !== undefined) {
    const stepIds = new Set(definition.steps.map(step => step.id))
    for (const entry of definition.compensationPlan.entries) {
      if (!stepIds.has(entry.stepId)) fail('invalid compensation plan step')
      if (entry.arguments !== undefined) {
        parameterBytes += bytes(JSON.stringify(entry.arguments))
        if (parameterBytes > maxBytes) fail('byte limit')
      }
      if (definition.compensation === 'compensating-action') {
        const toolName = entry.toolName
        if (!toolName || isReplayControlTool(toolName, entry.arguments) || (!NATIVE_REPLAY_FS_TOOLS.has(toolName) && !domainTools.has(toolName)) || !record(entry.arguments)) {
          return fail('invalid compensating-action tool')
        }
        checkedStep({ toolName, arguments: entry.arguments }, definition.source.scope.workspace, '/assistant-skills-validation', domainTools)
      }
    }
  }
  return trace
}

async function total(root: string): Promise<number> {
  let size = 0
  for (const entry of await readdir(root, { withFileTypes: true })) { const path = join(root, entry.name); const stat = await lstat(path); if (stat.isSymbolicLink()) fail('symlink detected'); if (stat.isDirectory()) size += await total(path); else if (stat.isFile()) size += stat.size; else fail('non-regular file') }
  return size
}

type ReplayPreimageEntry = { path: string; existed: boolean; content?: string }
type ReplayStepPreimage =
  | { readonly kind: 'fs'; readonly files: readonly ReplayPreimageEntry[] }
  | { readonly kind: 'snapshot'; readonly snapshot: Readonly<Record<string, unknown>> }

async function captureReplayFilePreimage(filePath: string): Promise<ReplayPreimageEntry> {
  try {
    const stat = await lstat(filePath)
    if (stat.isSymbolicLink()) fail('symlink detected')
    if (stat.isFile()) {
      return { path: filePath, existed: true, content: await readFile(filePath, 'utf8') }
    }
    return { path: filePath, existed: false }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { path: filePath, existed: false }
    }
    throw error
  }
}

async function restoreReplayFilePreimage(
  root: string,
  rootReal: string,
  filePre: ReplayPreimageEntry,
  options?: { readonly allowAncestorDirectoryCollision?: boolean },
): Promise<void> {
  await assertNoSymlinkForPath(root, filePre.path, { allowNonDirectoryParent: !filePre.existed })
  const rel = relative(root, filePre.path)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('external path')
  const expectedReal = resolve(rootReal, rel)
  if (filePre.existed) {
    try {
      const existingStat = await lstat(filePre.path)
      if (existingStat.isSymbolicLink() || !existingStat.isFile()) fail('rollback target unsafe')
      if (await realpath(filePre.path) !== expectedReal) fail('rollback target unsafe')
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
    }
    const parentDir = dirname(filePre.path)
    if (parentDir !== root) {
      await assertNoSymlinkForPath(root, parentDir)
    }
    await mkdir(parentDir, { recursive: true })
    if (parentDir !== root) {
      await assertNoSymlinkForPath(root, parentDir)
    }
    const parentReal = await realpath(parentDir)
    if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${sep}`)) fail('rollback target unsafe')
    await assertNoSymlinkForPath(root, filePre.path)
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0)
    const handle = await open(filePre.path, flags, 0o666)
    try {
      await handle.writeFile(filePre.content ?? '', 'utf8')
    } finally {
      await handle.close()
    }
    const postStat = await lstat(filePre.path)
    if (postStat.isSymbolicLink() || !postStat.isFile()) fail('rollback target unsafe')
    if (await realpath(filePre.path) !== expectedReal) fail('rollback target unsafe')
    return
  }
  try {
    const existingStat = await lstat(filePre.path)
    if (existingStat.isSymbolicLink()) fail('rollback target unsafe')
    if (existingStat.isDirectory() && options?.allowAncestorDirectoryCollision === true) {
      if (await realpath(filePre.path) !== expectedReal) fail('rollback target unsafe')
      return
    }
    if (!existingStat.isFile()) fail('rollback target unsafe')
    if (await realpath(filePre.path) !== expectedReal) fail('rollback target unsafe')
    await unlink(filePre.path)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
  }
}

export async function replaySkill(input: ReplayInput): Promise<ReplayResult> {
  if (!input || !Number.isSafeInteger(input.maxToolCalls) || input.maxToolCalls < 0 || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0 || !Array.isArray(input.files) || typeof input.stateRoot !== 'string' || !isAbsolute(input.stateRoot)) fail('invalid input')
  input.signal.throwIfAborted(); input.authorize(); const definition = instantiate(input.definition, input.inputs); if (definition.steps.length > 32 || definition.steps.length > input.maxToolCalls) fail('tool-call limit')
  const workspace = definition.source.scope.workspace; if (typeof workspace !== 'string' || !isAbsolute(workspace)) fail('invalid source workspace')
  if (input.files.length > 64) fail('file count limit')
  const domainHandlers = new Map<string, { mutating: boolean; handler: ReplayDomainToolHandler }>()
  const domainToolsPolicy: Record<string, ReplayDomainToolPolicy> = {}
  if (input.domainToolHandlers !== undefined) {
    if (!record(input.domainToolHandlers)) fail('invalid domain tool handlers')
    for (const [toolName, entry] of Object.entries(input.domainToolHandlers)) {
      if (!SUPPORTED_REPLAY_DOMAIN_TOOLS.has(toolName) || NATIVE_REPLAY_FS_TOOLS.has(toolName) || isReplayControlTool(toolName, {})) {
        fail('invalid tool')
      }
      if (typeof entry === 'function') {
        const mutating = MUTATING_REPLAY_DOMAIN_TOOLS.has(toolName)
        domainHandlers.set(toolName, { mutating, handler: entry })
        domainToolsPolicy[toolName] = { mutating }
      } else if (record(entry) && typeof entry.handler === 'function') {
        const mutating = typeof entry.mutating === 'boolean' ? entry.mutating : MUTATING_REPLAY_DOMAIN_TOOLS.has(toolName)
        domainHandlers.set(toolName, { mutating, handler: entry.handler })
        domainToolsPolicy[toolName] = { mutating }
      } else {
        fail('invalid domain tool handler')
      }
    }
  }
  const domainToolsMap = checkedDomainToolsOption(domainToolsPolicy)
  await mkdir(input.stateRoot, { recursive: true, mode: 0o700 })
  const directory = await lstat(input.stateRoot)
  if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(input.stateRoot) !== input.stateRoot || (directory.mode & 0o077) !== 0) fail('private state root required')
  const root = await mkdtemp(join(input.stateRoot, 'skill-replay-')); let ctx: Context | undefined
  let outcome: ReplayResult | undefined, failure: unknown, cleanup: unknown; let failed = false
  try {
    const rootReal = await realpath(root)
    const trace = validateReplayTrace(
      definition,
      input.maxToolCalls,
      input.maxBytes,
      domainToolsMap.size > 0 ? { domainTools: domainToolsPolicy } : undefined,
    )
    const expanded = dispatchSteps(definition)
    const steps = expanded.map((step, index) => trace[index]!.outcome === 'executed' ? { ...step, arguments: checkedStep(step, workspace, root, domainToolsMap), trace: trace[index]! } : { ...step, trace: trace[index]! })
    const compensationArgBytes = (definition.compensationPlan?.entries ?? []).reduce(
      (sum, entry) => sum + (entry.arguments === undefined ? 0 : bytes(JSON.stringify(entry.arguments))),
      0,
    )
    const parameterBytes = expanded.reduce((sum, step) => sum + bytes(JSON.stringify(step.arguments)), 0) + compensationArgBytes
    const files = input.files.map(file => { if (!file || typeof file.content !== 'string') fail('invalid file'); return { path: pathIn(file.path, workspace, root), content: file.content } })
    if (parameterBytes + files.reduce((sum, file) => sum + bytes(file.content), 0) > input.maxBytes) fail('byte limit')
    for (const file of files) { input.signal.throwIfAborted(); input.authorize(); await mkdir(resolve(file.path, '..'), { recursive: true }); await writeFile(file.path, file.content, { flag: 'wx' }) }
    if (parameterBytes + await total(root) > input.maxBytes) fail('byte limit')
    ctx = new Context()
    new SessionProjectionRegistry(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(WorkingDirectoryService, { defaultDirectory: root })
    await ctx.plugin(FileTools, { applyPatch: true })
    for (const [toolName, adapter] of domainHandlers) {
      ctx.tools.register(defineTool({
        name: toolName,
        description: `Bounded offline replay adapter for ${toolName}`,
        parameters: {},
        output: {
          schema: { type: 'string' as const },
          render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
        },
        execute: async (args, exec) => {
          const result = await adapter.handler(args as Readonly<Record<string, unknown>>, {
            root,
            workspace,
            signal: exec.signal,
          })
          return typeof result === 'string' ? result : JSON.stringify(result ?? null)
        },
      }))
    }
    const done: ReplayStep[] = []
    const stepById = new Map(steps.map(step => [step.id, step]))
    const directive = compensationDirective(definition.compensation)
    const preimages = new Map<string, ReplayStepPreimage>()
    const planByStep = new Map((definition.compensationPlan?.entries ?? []).map(entry => [entry.stepId, entry]))
    const hasExplicitPlan = definition.compensationPlan !== undefined
    // Dependency DAG gate: a step dispatches only after every declared
    // predecessor executed successfully. The v1 stop-and-report compensation is
    // realized by throwing, which aborts the remaining ordered steps.
    const succeededSteps = new Set<string>()
    for (const step of steps) {
      input.signal.throwIfAborted(); input.authorize()
      if (step.dependsOn.some(dependency => !succeededSteps.has(dependency))) fail('dependency predecessor did not succeed')
      // Deterministic provenance-only observations cannot fail; mark their node
      // satisfied so a later executable step may legally depend on them.
      if (step.trace.outcome === 'omitted-observation') { done.push(step.trace); succeededSteps.add(step.id); continue }
      if (step.toolName === 'apply_patch') {
        const affected = extractPatchAffectedPaths((step.arguments as { input: string }).input)
        for (const relPath of affected) {
          await assertNoSymlinkForPath(root, pathIn(relPath, workspace, root))
        }
        if (directive.capturePreimage) {
          const entries: ReplayPreimageEntry[] = []
          for (const relPath of affected) {
            entries.push(await captureReplayFilePreimage(pathIn(relPath, workspace, root)))
          }
          preimages.set(step.id, { kind: 'fs', files: entries })
        }
      } else if (directive.capturePreimage && (step.toolName === 'write' || step.toolName === 'edit')) {
        const filePath = (step.arguments as { file_path: string }).file_path
        await assertNoSymlinkForPath(root, filePath)
        preimages.set(step.id, { kind: 'fs', files: [await captureReplayFilePreimage(filePath)] })
      } else if (directive.capturePreimage && planByStep.get(step.id)?.capturePreimage === true && !isNonMutatingStep(step)) {
        preimages.set(step.id, {
          kind: 'snapshot',
          snapshot: {
            toolName: step.toolName,
            stepId: step.id,
            arguments: JSON.parse(JSON.stringify(step.arguments)) as Record<string, unknown>,
          },
        })
      }
      const batch = await executeSingleTool(ctx.tools, { callId: ToolCallId(`skill-replay-${done.length + 1}`), name: step.toolName, arguments: step.arguments, signal: input.signal })
      const result = batch.results[0]!.result
      input.signal.throwIfAborted(); input.authorize()
      const observedAbsent = step.observationAllowsAbsent === true && result.isError && result.error.info?.code === 'FS_NOT_FOUND'
      const patchInspection = step.toolName === 'apply_patch' && !result.isError
        ? inspectApplyPatchValue(result.value)
        : 'completed'
      const stepFailed = (result.isError && !observedAbsent) || patchInspection !== 'completed'
      if (stepFailed) {
        if (directive.executeCompensation && patchInspection !== 'partial-unknown') {
          const priorIds = done
            .filter(entry => entry.outcome === 'executed' && !entry.id.startsWith('file-observation:'))
            .map(entry => entry.id)
            .reverse()
          const executedIds = step.toolName === 'apply_patch' && preimages.has(step.id)
            ? [step.id, ...priorIds]
            : priorIds
          for (const prevId of executedIds) {
            const prevStep = stepById.get(prevId)
            if (!prevStep) continue
            const spec = planByStep.get(prevId)
            if (directive.kind === 'rollback-state') {
              const pre = preimages.get(prevId)
              if (pre?.kind === 'fs') {
                const isFailingApplyPatch = prevId === step.id && prevStep.toolName === 'apply_patch'
                for (const filePre of [...pre.files].reverse()) {
                  const fileIndex = pre.files.indexOf(filePre)
                  const allowAncestorDirectoryCollision = isFailingApplyPatch
                    && !filePre.existed
                    && pre.files.some((other, otherIndex) =>
                      otherIndex < fileIndex && other.path.startsWith(`${filePre.path}${sep}`),
                    )
                  await restoreReplayFilePreimage(root, rootReal, filePre, { allowAncestorDirectoryCollision })
                }
              }
            } else if (directive.kind === 'compensating-action') {
              if (spec?.toolName && (NATIVE_REPLAY_FS_TOOLS.has(spec.toolName) || domainToolsMap.has(spec.toolName)) && record(spec.arguments)) {
                const args = checkedStep({ toolName: spec.toolName, arguments: spec.arguments }, workspace, root, domainToolsMap)
                await executeSingleTool(ctx.tools, {
                  callId: ToolCallId(`skill-replay-comp-${prevId}`),
                  name: spec.toolName,
                  arguments: args,
                  signal: input.signal,
                })
              }
            } else if (directive.kind === 'compensate-via-registry') {
              if (hasExplicitPlan && spec === undefined) continue
              if (!hasExplicitPlan && isNonMutatingStep(prevStep)) continue
              if (input.compensationPort !== undefined) {
                const pre = preimages.get(prevId)
                const preimageDigest = pre ? acceptanceDigest(pre) : undefined
                const compKey = spec?.compensatorKey ?? `skill.${definition.name}.${prevId}`
                await input.compensationPort.executeCompensation(
                  {
                    idempotencyKey: `skill-replay-comp:v1:${acceptanceDigest([definition.source.scope, definition.name, prevId, compKey, preimageDigest ?? null])}`,
                    kind: compKey,
                    target: {
                      skillName: definition.name,
                      stepId: prevId,
                      toolName: prevStep.toolName,
                      arguments: prevStep.arguments as Readonly<Record<string, unknown>>,
                    },
                    forwardActionId: `replay:${prevId}`,
                    scope: definition.source.scope,
                    sourcePlugin: 'dsh-enhanced-assistant-skills',
                    stepId: prevId,
                    ...(pre === undefined ? {} : { preimage: { digest: preimageDigest!, ...(pre.kind === 'snapshot' ? { snapshot: pre.snapshot } : { files: pre.files }) } }),
                  },
                  { signal: input.signal },
                )
              }
            }
          }
        }
        throw new Error(
          patchInspection === 'partial-unknown'
            ? `assistant-skills: replay ${step.toolName} unknown`
            : `assistant-skills: replay ${step.toolName} failed`,
        )
      }
      if (parameterBytes + await total(root) > input.maxBytes) fail('byte limit')
      done.push({ id: step.id, toolName: step.toolName, outcome: 'executed', resultDigest: acceptanceDigest(result.content) })
      succeededSteps.add(step.id)
    }
    const artifactFile = pathIn(input.artifactPath, workspace, root); const stat = await lstat(artifactFile); if (!stat.isFile() || stat.isSymbolicLink()) fail('invalid artifact'); outcome = { artifact: await readFile(artifactFile, 'utf8'), toolCalls: done.length,
      executedToolCalls: done.filter(step => step.outcome === 'executed').length, omittedObservations: done.filter(step => step.outcome === 'omitted-observation').length, steps: done, quiescent: true }
  } catch (error) { failed = true; failure = error } finally { try { if (ctx) await ctx.fiber.dispose() } catch (error) { cleanup = error } try { await rm(root, { recursive: true, force: true }) } catch (error) { if (!cleanup) cleanup = error }  }
  if (cleanup) throw cleanup
  if (failed) throw failure
  return outcome!
}
