import { isAbsolute, resolve as normalizePath } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsInfo } from '@deepseek-ai/dsh-fs'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import type { EvidenceAnchor } from './evidence-ledger.js'
import type { OriginalToolEvidence } from './evidence-runtime.js'

interface ReadArguments {
  readonly kind: 'read'
  readonly file_path: string
  readonly offset?: number
  readonly limit?: number
}

interface ReadImageArguments {
  readonly kind: 'read_image'
  readonly file_path: string
}

type FileEvidenceArguments = ReadArguments | ReadImageArguments

/**
 * Read-only file-observation tools whose present anchor can be revalidated by
 * re-running the same tool. Both resolve through `resolveRegularReadTarget` and
 * emit the same `fs/observed` present shape, so the anchor columns and freshness
 * proof are tool-agnostic. Mutation/arbitrary tools must never be added here.
 */
export const REVALIDATABLE_READ_TOOLS: ReadonlySet<string> = new Set(['read', 'read_image'])

function parseObject(value: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

function validFilePath(record: Record<string, unknown>): string | undefined {
  if (typeof record.file_path !== 'string' || record.file_path.trim() === '' || record.file_path.length > 4_096) return undefined
  return record.file_path
}

function parseReadArguments(value: string): ReadArguments | undefined {
  const record = parseObject(value)
  if (record === undefined) return undefined
  if (!Object.keys(record).every(key => key === 'file_path' || key === 'offset' || key === 'limit')) return undefined
  const file_path = validFilePath(record)
  if (file_path === undefined) return undefined
  const offset = record.offset
  const limit = record.limit
  if ((offset !== undefined && (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset <= 0))
    || (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0))) return undefined
  return Object.freeze({
    kind: 'read',
    file_path,
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  })
}

function parseReadImageArguments(value: string): ReadImageArguments | undefined {
  const record = parseObject(value)
  if (record === undefined) return undefined
  // The production tool schema accepts only file_path; reject any other shape.
  if (!Object.keys(record).every(key => key === 'file_path')) return undefined
  const file_path = validFilePath(record)
  if (file_path === undefined) return undefined
  return Object.freeze({ kind: 'read_image', file_path })
}

function parseFileEvidenceArguments(toolName: string, value: string): FileEvidenceArguments | undefined {
  if (toolName === 'read') return parseReadArguments(value)
  if (toolName === 'read_image') return parseReadImageArguments(value)
  return undefined
}

function replayedArguments(args: FileEvidenceArguments): Record<string, unknown> {
  if (args.kind === 'read_image') return { file_path: args.file_path }
  return { file_path: args.file_path,
    ...(args.offset === undefined ? {} : { offset: args.offset }),
    ...(args.limit === undefined ? {} : { limit: args.limit }) }
}

function currentAgent(ctx: Context, exec: ToolExecution): boolean {
  const agent = exec.agent
  return agent !== undefined && agent.status === 'running'
    && ctx.get('agents', false)?.get(agent.id) === agent
    && ctx.get('sessions', false)?.get(agent.session.id) === agent.session
}

function regularFile(info: FsInfo | undefined): info is FsInfo {
  return info?.type === 'file'
}

/**
 * Re-run an original read-only file observation through the live tool pipeline.
 * Policy resources use the filesystem provider's canonical process path, rather
 * than `displayPath`: `displayPath` is presentation text and may be relative or
 * a URI, while `processPath()` is the provider's absolute execution-world path.
 *
 * `read` and `read_image` share the filesystem `read` action: both are
 * idempotent reads of one resolved regular file (the policy risk classifier
 * groups them), so a read_image anchor is re-gated with the same path resource
 * rather than inventing a new action that no host rule could grant.
 */
export async function revalidateFileEvidence(
  ctx: Context,
  policy: AssistantPolicyService,
  exec: ToolExecution,
  source: OriginalToolEvidence,
  anchor: EvidenceAnchor,
): Promise<boolean> {
  if (source.failed || anchor.toolName !== source.toolName
    || !REVALIDATABLE_READ_TOOLS.has(source.toolName)
    || exec.signal.aborted || !currentAgent(ctx, exec)) return false
  const toolName = source.toolName as 'read' | 'read_image'
  const args = parseFileEvidenceArguments(toolName, source.callArguments)
  if (args === undefined) return false

  const fs = ctx.get('fs', false) as FileSystem | undefined
  const tools = ctx.get('tools', false) as ToolRuntime | undefined
  const agent = exec.agent
  const cwd = agent?.session.header.cwd
  if (fs === undefined || tools === undefined || agent === undefined || cwd === undefined) return false
  const toolDefinition = tools.get(toolName, agent)
  // read_image is conditionally registered only while an attachment store is
  // mounted, so an undefined definition already fails closed here.
  if (toolDefinition === undefined) return false

  try {
    const target = await fs.resolve(args.file_path, { cwd, signal: exec.signal })
    const processPath = fs.processPath(target)
    if (!isAbsolute(processPath) || normalizePath(processPath) !== processPath) return false
    if (processPath !== anchor.sourcePath || digestTarget(target) !== anchor.sourceTargetDigest) return false
    const before = await fs.stat(target, exec.signal)
    if (!regularFile(before) || exec.signal.aborted) return false
    if (policy.authorizeAgent(agent, 'read', { kind: 'filesystem', id: processPath }).effect !== 'allow') return false

    const result = await tools.execute({
      callId: ToolCallId(`${exec.callId}:evidence-revalidate`),
      rootCallId: exec.rootCallId,
      parent: exec.token,
      name: toolName,
      agent,
      signal: exec.signal,
      arguments: { ...replayedArguments(args), file_path: processPath },
    })
    if (result.isError || exec.signal.aborted) return false

    // Re-resolve the original spelling to detect an alias/symlink replacement
    // while the nested read ran.  The opaque target key and version are the
    // backend-owned identity and freshness proof; neither is parsed here. The
    // replayed image content carries a fresh volatile attachmentId, so the
    // decision intentionally anchors on target identity/version, never on the
    // result body.
    const currentFs = ctx.get('fs', false) as FileSystem | undefined
    const currentTools = ctx.get('tools', false) as ToolRuntime | undefined
    // Cordis returns a fresh trace proxy on each lookup; its per-instance
    // tracker is stable across proxies and changes with service replacement.
    if (currentFs === undefined || currentTools === undefined
      || Reflect.get(fs, Service.tracker) === undefined || Reflect.get(tools, Service.tracker) === undefined
      || Reflect.get(currentFs, Service.tracker) !== Reflect.get(fs, Service.tracker)
      || Reflect.get(currentTools, Service.tracker) !== Reflect.get(tools, Service.tracker)
      || currentTools.get(toolName, agent) !== toolDefinition) return false
    const finalTarget = await fs.resolve(args.file_path, { cwd, signal: exec.signal })
    if (finalTarget.targetKey !== target.targetKey || fs.processPath(finalTarget) !== processPath
      || fs.processPath(finalTarget) !== anchor.sourcePath || digestTarget(finalTarget) !== anchor.sourceTargetDigest) return false
    const after = await fs.stat(finalTarget, exec.signal)
    if (!regularFile(after) || after.version !== before.version || exec.signal.aborted) return false
    return policy.authorizeAgent(agent, 'read', { kind: 'filesystem', id: processPath }).effect === 'allow'
  } catch {
    return false
  }
}

function digestTarget(target: { targetKey: unknown }): string {
  return createHash('sha256').update(String(target.targetKey)).digest('hex')
}
