import { chmod, lstat, mkdir, open } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { IsolationFile, IsolationLimits, IsolationRequest } from './types.js'

const maxText = 16_384
const control = /[\p{Cc}]/u
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
function fail(message: string): never { throw new Error(`invalid isolation workspace: ${message}`) }
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const bytes = (value: string): number => Buffer.byteLength(value, 'utf8')
const pathOrder = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

function limitsInput(value: IsolationLimits): IsolationLimits {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 10
    || !positive(value.maxDurationMs) || !positive(value.maxInputBytes) || !positive(value.maxOutputBytes) || !positive(value.maxArtifactBytes)
    || !positive(value.workspaceMiB) || !positive(value.workspaceInodes) || !positive(value.maxFiles) || !positive(value.memoryMiB) || !positive(value.pidsLimit) || !Number.isFinite(value.cpus) || value.cpus <= 0) fail('invalid limits')
  return value
}

function scalar(value: unknown, name: string, maximum = maxText): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || control.test(value)) fail(`invalid ${name}`)
  return value
}

/** Canonical relative path syntax shared by input staging and artifact collection. */
function pathInput(value: unknown): string {
  const path = scalar(value, 'path', 4096)
  if (isAbsolute(path) || path.includes('\\') || path.startsWith('./') || path.endsWith('/') || path.includes('//')) fail('non-canonical path')
  const parts = path.split('/')
  if (parts.some(part => part.length === 0 || part === '.' || part === '..')) fail('unsafe path')
  return path
}

function canonicalPaths(values: unknown, name: string, maximum: number): string[] {
  if (!Array.isArray(values) || values.length > maximum) fail(`invalid ${name}`)
  const paths = values.map(pathInput).sort(pathOrder)
  if (paths.some((path, index) => index > 0 && path === paths[index - 1])) fail(`duplicate ${name}`)
  return paths
}

function assertNoFileParentConflict(files: IsolationFile[]): void {
  for (let index = 1; index < files.length; index += 1) if (files[index]!.path.startsWith(`${files[index - 1]!.path}/`)) fail('file parent conflict')
}

/** Rejects model-controlled ambiguity before hashing, auditing, or staging a request. */
export function normalizeRequest(request: IsolationRequest, limits: IsolationLimits): IsolationRequest {
  const configured = limitsInput(limits)
  if (!request || typeof request !== 'object' || !Object.keys(request).every(key => ['grantId', 'idempotencyKey', 'command', 'files', 'artifacts', 'timeoutMs'].includes(key))
    || !scalar(request.grantId, 'grant id', 256) || !scalar(request.idempotencyKey, 'idempotency key', 256)
    || typeof request.command !== 'string' || request.command.length === 0 || request.command.includes('\0')) fail('invalid request')
  const timeoutMs = request.timeoutMs === undefined ? configured.maxDurationMs : request.timeoutMs
  if (!positive(timeoutMs) || timeoutMs > configured.maxDurationMs) fail('invalid timeout')
  const rawFiles = request.files === undefined ? [] : request.files
  if (!Array.isArray(rawFiles) || rawFiles.length > configured.maxFiles) fail('invalid files')
  const files = rawFiles.map(file => {
    if (!file || typeof file !== 'object' || !Object.keys(file).every(key => key === 'path' || key === 'content') || Object.keys(file).length !== 2 || typeof file.content !== 'string') fail('invalid file')
    return { path: pathInput(file.path), content: file.content }
  }).sort((left, right) => pathOrder(left.path, right.path))
  if (files.some((file, index) => index > 0 && file.path === files[index - 1]!.path)) fail('duplicate files')
  assertNoFileParentConflict(files)
  const artifacts = request.artifacts === undefined ? [] : canonicalPaths(request.artifacts, 'artifacts', configured.maxFiles)
  const inputBytes = bytes(request.command) + files.reduce((total, file) => total + bytes(file.path) + bytes(file.content), 0) + artifacts.reduce((total, path) => total + bytes(path), 0)
  if (!Number.isSafeInteger(inputBytes) || inputBytes > configured.maxInputBytes) fail('input exceeds limit')
  const inputEntries = new Set<string>()
  for (const file of files) {
    const parts = file.path.split('/')
    for (let index = 1; index <= parts.length; index++) inputEntries.add(parts.slice(0, index).join('/'))
  }
  if (inputEntries.size + 1 > configured.workspaceInodes) fail('input exceeds workspace inode limit')
  if (files.reduce((total, file) => total + bytes(file.content), 0) > configured.workspaceMiB * 1_048_576) fail('input exceeds workspace byte limit')
  return Object.freeze({ grantId: request.grantId, idempotencyKey: request.idempotencyKey, command: request.command, ...(files.length ? { files: files.map(file => Object.freeze(file)) } : {}), ...(artifacts.length ? { artifacts } : {}), timeoutMs })
}

async function directory(path: string, create: boolean): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 })
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink()) fail('directory is not private')
  await chmod(path, 0o700)
}

async function privateParents(root: string, relativePath: string): Promise<string> {
  let current = root
  const parts = relativePath.split('/'); parts.pop()
  for (const part of parts) { current = resolve(current, part); await mkdir(current, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }); await directory(current, false) }
  return current
}

/** Creates a fresh, job-only workspace. It deliberately never copies a project checkout. */
export async function stageWorkspace(stateRoot: string, jobId: string, request: IsolationRequest): Promise<string> {
  if (!isAbsolute(stateRoot) || !uuid.test(jobId)) fail('invalid staging root or job id')
  await directory(stateRoot, true)
  const workspaces = resolve(stateRoot, 'workspaces'); await directory(workspaces, true)
  const jobRoot = resolve(workspaces, jobId)
  try { await mkdir(jobRoot, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('workspace collision'); throw error }
  await directory(jobRoot, false)
  const workspace = resolve(jobRoot, 'workspace'); await mkdir(workspace, { mode: 0o700 }); await directory(workspace, false)
  const files = request.files ?? []
  for (const file of files) {
    const path = pathInput(file.path); if (typeof file.content !== 'string') fail('invalid staged file')
    const parent = await privateParents(workspace, path); const target = resolve(parent, path.slice(path.lastIndexOf('/') + 1))
    const handle = await open(target, 'wx', 0o600)
    try { await handle.writeFile(file.content, 'utf8'); await handle.chmod(0o600) } finally { await handle.close() }
  }
  return workspace
}
