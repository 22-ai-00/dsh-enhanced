import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { IsolationFile, IsolationLimits, IsolationRequest } from './types.js'

const maxText = 16_384
const control = /[\p{Cc}]/u
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
function fail(message: string): never { throw new Error(`invalid isolation workspace: ${message}`) }
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const bytes = (value: string): number => Buffer.byteLength(value, 'utf8')
const pathOrder = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

function limitsInput(value: IsolationLimits): IsolationLimits {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 8
    || !positive(value.maxDurationMs) || !positive(value.maxInputBytes) || !positive(value.maxOutputBytes) || !positive(value.maxArtifactBytes)
    || !positive(value.maxFiles) || !positive(value.memoryMiB) || !positive(value.pidsLimit) || !Number.isFinite(value.cpus) || value.cpus <= 0) fail('invalid limits')
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
  const inputBytes = bytes(request.command) + files.reduce((total, file) => total + bytes(file.content), 0)
  if (!Number.isSafeInteger(inputBytes) || inputBytes > configured.maxInputBytes) fail('input exceeds limit')
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

function contained(root: string, target: string): boolean { const path = relative(root, target); return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path) }

async function artifactHandle(workspace: string, root: string, path: string) {
  let current = workspace
  const parts = path.split('/')
  for (const part of parts.slice(0, -1)) { current = resolve(current, part); const entry = await lstat(current); if (!entry.isDirectory() || entry.isSymbolicLink()) fail('artifact parent is unsafe') }
  const target = resolve(current, parts[parts.length - 1]!); const link = await lstat(target)
  if (link.isSymbolicLink() || !link.isFile()) fail('artifact is not a regular file')
  const canonical = await realpath(target); if (!contained(root, canonical)) fail('artifact escapes workspace')
  return open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
}

/** Reads only settled, regular, non-linked artifacts from a private staged workspace. */
export async function collectArtifacts(workspacePath: string, paths: string[], limits: IsolationLimits): Promise<IsolationFile[]> {
  const configured = limitsInput(limits)
  if (!isAbsolute(workspacePath)) fail('workspace must be absolute')
  const requested = canonicalPaths(paths, 'artifacts', configured.maxFiles)
  const workspaceEntry = await lstat(workspacePath); if (!workspaceEntry.isDirectory() || workspaceEntry.isSymbolicLink()) fail('workspace is unsafe')
  const root = await realpath(workspacePath); const files: IsolationFile[] = []; let total = 0
  for (const path of requested) {
    const handle = await artifactHandle(workspacePath, root, path)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.nlink !== 1 || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > configured.maxArtifactBytes - total) fail('artifact is not a bounded regular file')
      const content = Buffer.alloc(info.size); let offset = 0
      while (offset < content.length) { const read = await handle.read(content, offset, content.length - offset, offset); if (read.bytesRead === 0) fail('artifact changed while reading'); offset += read.bytesRead }
      const extra = Buffer.alloc(1); if ((await handle.read(extra, 0, 1, info.size)).bytesRead !== 0) fail('artifact grew while reading')
      total += content.length; files.push(Object.freeze({ path, content: new TextDecoder('utf-8', { fatal: true }).decode(content) }))
    } finally { await handle.close() }
  }
  return files
}
