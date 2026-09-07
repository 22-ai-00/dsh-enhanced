import { isAbsolute, resolve as normalizePath } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsInfo } from '@deepseek-ai/dsh-fs'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import type { EvidenceAnchor } from './evidence-ledger.js'
import type { OriginalToolEvidence } from './evidence-runtime.js'

interface ReadArguments {
  readonly file_path: string
  readonly offset?: number
  readonly limit?: number
}

function parseReadArguments(value: string): ReadArguments | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if (!Object.keys(record).every(key => key === 'file_path' || key === 'offset' || key === 'limit')) return undefined
  const offset = record.offset
  const limit = record.limit
  if (typeof record.file_path !== 'string' || record.file_path.trim() === '' || record.file_path.length > 4_096) return undefined
  if ((offset !== undefined && (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset <= 0))
    || (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0))) return undefined
  return Object.freeze({
    file_path: record.file_path,
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  })
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
 * Re-run an original `read` through the live tool pipeline.  Policy resources
 * use the filesystem provider's canonical process path, rather than
 * `displayPath`: `displayPath` is presentation text and may be relative or a
 * URI, while `processPath()` is the provider's absolute execution-world path.
 */
export async function revalidateFileEvidence(
  ctx: Context,
  policy: AssistantPolicyService,
  exec: ToolExecution,
  source: OriginalToolEvidence,
  anchor: EvidenceAnchor,
): Promise<boolean> {
  if (source.toolName !== 'read' || source.failed || anchor.toolName !== 'read'
    || exec.signal.aborted || !currentAgent(ctx, exec)) return false
  const args = parseReadArguments(source.callArguments)
  if (args === undefined) return false

  const fs = ctx.get('fs', false) as FileSystem | undefined
  const tools = ctx.get('tools', false) as ToolRuntime | undefined
  const agent = exec.agent
  const cwd = agent?.session.header.cwd
  if (fs === undefined || tools === undefined || agent === undefined || cwd === undefined) return false
  const readDefinition = tools.get('read', agent)
  if (readDefinition === undefined) return false

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
      name: 'read',
      agent,
      signal: exec.signal,
      arguments: { file_path: processPath, ...(args.offset === undefined ? {} : { offset: args.offset }),
        ...(args.limit === undefined ? {} : { limit: args.limit }) },
    })
    if (result.isError || exec.signal.aborted) return false

    // Re-resolve the original spelling to detect an alias/symlink replacement
    // while the nested read ran.  The opaque target key and version are the
    // backend-owned identity and freshness proof; neither is parsed here.
    const currentFs = ctx.get('fs', false) as FileSystem | undefined
    const currentTools = ctx.get('tools', false) as ToolRuntime | undefined
    // Cordis returns a fresh trace proxy on each lookup; its per-instance
    // tracker is stable across proxies and changes with service replacement.
    if (currentFs === undefined || currentTools === undefined
      || Reflect.get(fs, Service.tracker) === undefined || Reflect.get(tools, Service.tracker) === undefined
      || Reflect.get(currentFs, Service.tracker) !== Reflect.get(fs, Service.tracker)
      || Reflect.get(currentTools, Service.tracker) !== Reflect.get(tools, Service.tracker)
      || currentTools.get('read', agent) !== readDefinition) return false
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
import { createHash } from 'node:crypto'
