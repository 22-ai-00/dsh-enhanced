import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as FileTools from '@deepseek-ai/dsh-tool-fs'
import { lstat, mkdir, mkdtemp, realpath, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { instantiate, type SkillDefinition } from './definition.js'

export interface ReplayInput { definition: SkillDefinition; inputs: Readonly<Record<string, unknown>>; files: readonly { path: string; content: string }[]; artifactPath: string; stateRoot: string; maxToolCalls: number; maxBytes: number; signal: AbortSignal; authorize: () => void }
export interface ReplayResult { artifact: string; toolCalls: number; steps: readonly { id: string; toolName: string; resultDigest: string }[]; quiescent: true }
const fail = (message: string): never => { throw new Error(`assistant-skills: replay ${message}`) }
const bytes = (value: string) => Buffer.byteLength(value, 'utf8')
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
function checkedStep(step: { toolName: string; arguments: unknown }, workspace: string, root: string): Record<string, unknown> {
  if (!['read', 'write', 'edit'].includes(step.toolName) || !step.arguments || typeof step.arguments !== 'object' || Array.isArray(step.arguments)) fail('invalid tool')
  const args = step.arguments as Record<string, unknown>; const allowed = step.toolName === 'read' ? ['file_path', 'offset', 'limit'] : step.toolName === 'write' ? ['file_path', 'content'] : ['file_path', 'old_string', 'new_string', 'replace_all']
  if (Object.keys(args).some(key => !allowed.includes(key)) || typeof args.file_path !== 'string') fail('invalid tool arguments')
  if (step.toolName === 'write' && typeof args.content !== 'string' || step.toolName === 'edit' && (typeof args.old_string !== 'string' || typeof args.new_string !== 'string' || typeof args.replace_all !== 'undefined' && typeof args.replace_all !== 'boolean')) fail('invalid tool arguments')
  if (step.toolName === 'read' && (args.offset !== undefined && (typeof args.offset !== 'number' || !Number.isSafeInteger(args.offset) || args.offset < 1) || args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isSafeInteger(args.limit) || args.limit < 1))) fail('invalid tool arguments')
  return { ...args, file_path: pathIn(args.file_path, workspace, root) }
}
async function total(root: string): Promise<number> {
  let size = 0
  for (const entry of await readdir(root, { withFileTypes: true })) { const path = join(root, entry.name); const stat = await lstat(path); if (stat.isSymbolicLink()) fail('symlink detected'); if (stat.isDirectory()) size += await total(path); else if (stat.isFile()) size += stat.size; else fail('non-regular file') }
  return size
}
export async function replaySkill(input: ReplayInput): Promise<ReplayResult> {
  if (!input || !Number.isSafeInteger(input.maxToolCalls) || input.maxToolCalls < 0 || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0 || !Array.isArray(input.files) || typeof input.stateRoot !== 'string' || !isAbsolute(input.stateRoot)) fail('invalid input')
  input.signal.throwIfAborted(); input.authorize(); const definition = instantiate(input.definition, input.inputs); if (definition.steps.length > 32 || definition.steps.length > input.maxToolCalls) fail('tool-call limit')
  const workspace = definition.source.scope.workspace; if (typeof workspace !== 'string' || !isAbsolute(workspace)) fail('invalid source workspace')
  if (input.files.length > 64) fail('file count limit')
  await mkdir(input.stateRoot, { recursive: true, mode: 0o700 })
  const directory = await lstat(input.stateRoot)
  if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(input.stateRoot) !== input.stateRoot || (directory.mode & 0o077) !== 0) fail('private state root required')
  const root = await mkdtemp(join(input.stateRoot, 'skill-replay-')); let ctx: Context | undefined
  let outcome: ReplayResult | undefined, failure: unknown, cleanup: unknown; let failed = false
  try {
    let parameterBytes = 0
    const steps = definition.steps.map(step => { const args = checkedStep(step, workspace, root); parameterBytes += bytes(JSON.stringify(args)); return { ...step, arguments: args } })
    const files = input.files.map(file => { if (!file || typeof file.content !== 'string') fail('invalid file'); return { path: pathIn(file.path, workspace, root), content: file.content } })
    if (parameterBytes + files.reduce((sum, file) => sum + bytes(file.content), 0) > input.maxBytes) fail('byte limit')
    for (const file of files) { input.signal.throwIfAborted(); input.authorize(); await mkdir(resolve(file.path, '..'), { recursive: true }); await writeFile(file.path, file.content, { flag: 'wx' }) }
    if (parameterBytes + await total(root) > input.maxBytes) fail('byte limit')
    ctx = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(LocalFileSystem, { cwd: root }); await ctx.plugin(FileTools)
    const done: { id: string; toolName: string; resultDigest: string }[] = []
    for (const step of steps) { input.signal.throwIfAborted(); input.authorize(); const result = await ctx.tools.execute({ callId: ToolCallId(`skill-replay-${done.length + 1}`), name: step.toolName, arguments: step.arguments, signal: input.signal }); input.signal.throwIfAborted(); input.authorize(); if (result.isError) throw new Error(`assistant-skills: replay ${step.toolName} failed`); if (parameterBytes + await total(root) > input.maxBytes) fail('byte limit'); done.push({ id: step.id, toolName: step.toolName, resultDigest: acceptanceDigest(result.content) }) }
    const artifactFile = pathIn(input.artifactPath, workspace, root); const stat = await lstat(artifactFile); if (!stat.isFile() || stat.isSymbolicLink()) fail('invalid artifact'); outcome = { artifact: await readFile(artifactFile, 'utf8'), toolCalls: done.length, steps: done, quiescent: true }
  } catch (error) { failed = true; failure = error } finally { try { if (ctx) await ctx.fiber.dispose() } catch (error) { cleanup = error } try { await rm(root, { recursive: true, force: true }) } catch (error) { if (!cleanup) cleanup = error }  }
  if (cleanup) throw cleanup
  if (failed) throw failure
  return outcome!
}
