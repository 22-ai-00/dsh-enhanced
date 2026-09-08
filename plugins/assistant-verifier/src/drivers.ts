import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { chmod, lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import type {
  AcceptanceCriterion,
  CriterionResult,
  DocumentCitationsCriterion,
  IsolatedProcessBehaviorCriterion,
  ProcessBehaviorCriterion,
  TargetReadbackCriterion,
  TaskAcceptanceContract,
} from '@dsh-enhanced/task-acceptance-contract'
import { acceptanceCanonicalJson } from '@dsh-enhanced/task-acceptance-contract'

const MAX_AUTHORITIES = 64
const MAX_CONFIG_STRING = 16_384
const MAX_EXECUTABLE_BYTES = 128 * 1024 * 1024
const MAX_ARTIFACT_BYTES = 1_048_576
const MAX_ISOLATED_TEST_SETS = 64
const MAX_ISOLATED_CASES = 256
const MAX_ISOLATED_TEST_CASES = 1_024
const MAX_ISOLATED_TEST_BYTES = 65_536
const IMAGE = /^sha256:[a-f0-9]{64}$/u
const STABLE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u

export interface RunnerAuthorityInput {
  readonly kind: 'runner'
  readonly id: string
  readonly executable: string
  readonly fixedArgs: readonly string[]
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly environment?: Readonly<Record<string, string>>
}

export interface DocumentSourceInput { readonly id: string; readonly url: string }
export interface DocumentAuthorityInput {
  readonly kind: 'document'
  readonly id: string
  readonly sources: readonly DocumentSourceInput[]
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly allowHttpLoopback?: boolean
}

export interface ReadbackAuthorityInput {
  readonly kind: 'readback'
  readonly id: string
  readonly urlTemplate: string
  readonly objectIdPointer: string
  readonly revisionPointer?: string
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly allowHttpLoopback?: boolean
}

/** Fixed repository requirements; credentials and delivered head come only from Actions' Host ledger. */
export interface RepositoryReadbackAuthorityInput {
  readonly kind: 'repository-readback'; readonly id: string
  readonly grantId: string; readonly grantRevision: number; readonly repository: string; readonly branch: string; readonly baseBranch: string
  readonly requiredChecks: readonly { readonly name: string; readonly appId: number }[]
  readonly reviewerIds: readonly number[]; readonly minApprovals: number
  readonly timeoutMs: number; readonly freshnessMs: number
}
export interface RepositoryReadbackAuthority extends RepositoryReadbackAuthorityInput { readonly digest: string }
export interface RepositoryVerificationContext {
  read(contract: TaskAcceptanceContract, authority: RepositoryReadbackAuthority, signal: AbortSignal): Promise<unknown>
}

export interface IsolatedRunnerTestCaseInput {
  readonly stdin: string
  readonly expectedStdout: string
  readonly expectedExitCode: number
}
export interface IsolatedRunnerTestSetInput {
  readonly id: string
  readonly cases: readonly IsolatedRunnerTestCaseInput[]
}
export interface IsolatedRunnerAuthorityInput {
  readonly kind: 'isolated-runner'
  readonly id: string
  readonly stateRoot: string
  readonly image: string
  readonly dockerPath: string
  readonly command: string
  readonly expiresAt: number
  readonly maxRuns: number
  readonly maxTotalDurationMs: number
  readonly maxDurationMs: number
  readonly maxOutputBytes: number
  readonly testSets: readonly IsolatedRunnerTestSetInput[]
}

export type VerifierAuthorityInput = RunnerAuthorityInput | DocumentAuthorityInput | ReadbackAuthorityInput | IsolatedRunnerAuthorityInput | RepositoryReadbackAuthorityInput
export interface VerifierAuthoritiesConfig { readonly authorities: readonly VerifierAuthorityInput[] }

export interface RunnerAuthority extends Omit<RunnerAuthorityInput, 'environment'> {
  readonly environment: Readonly<Record<string, string>>
  readonly executableDigest: string
  readonly digest: string
}
export interface DocumentAuthority extends Omit<DocumentAuthorityInput, 'allowHttpLoopback'> {
  readonly allowHttpLoopback: boolean
  readonly digest: string
}
export interface ReadbackAuthority extends Omit<ReadbackAuthorityInput, 'allowHttpLoopback' | 'revisionPointer'> {
  readonly revisionPointer?: string
  readonly allowHttpLoopback: boolean
  readonly digest: string
}
export interface IsolatedRunnerAuthority extends IsolatedRunnerAuthorityInput {
  readonly digest: string
}
export type VerifierAuthority = RunnerAuthority | DocumentAuthority | ReadbackAuthority | IsolatedRunnerAuthority | RepositoryReadbackAuthority

export interface IsolatedVerificationContext {
  readArtifact(contract: TaskAcceptanceContract, path: string): Promise<{
    readonly jobId: string; readonly requestDigest: string; readonly path: string; readonly content: string; readonly sha256: string
  }>
  run(authority: IsolatedRunnerAuthority, key: string, artifact: string, stdin: string, signal: AbortSignal): Promise<{
    readonly jobId: string; readonly status: string; readonly quiescent: boolean; readonly exitCode?: number; readonly stdout: string; readonly stderr: string; readonly reason?: string
  }>
}

export class VerifierAuthorityError extends Error {
  constructor(readonly code: 'invalid-authority', message: string) {
    super(message)
    this.name = 'VerifierAuthorityError'
  }
}

function fail(message: string): never { throw new VerifierAuthorityError('invalid-authority', message) }
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be an object`)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(`${label} has unsupported fields`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`${label} has unsupported fields`)
  }
  return value as Record<string, unknown>
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} has unsupported fields`)
}
function allowedKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  for (const key of required) if (!(key in value)) fail(`${label} is missing ${key}`)
  const allowed = new Set([...required, ...optional])
  if (Object.keys(value).some(key => !allowed.has(key))) fail(`${label} has unsupported fields`)
}
function string(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > MAX_CONFIG_STRING || (!allowEmpty && value.length === 0) || value.includes('\0')) fail(`${label} must be a bounded string`)
  return value
}
function whole(value: unknown, label: string, maximum = 300_000): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) fail(`${label} must be a bounded positive integer`)
  return value as number
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  fail('authority contains an unsupported value')
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function validPointer(value: unknown, label: string): string {
  const pointer = string(value, label, true)
  if (pointer !== '' && (!pointer.startsWith('/') || /~(?:[^01]|$)/u.test(pointer))) fail(`${label} must be an RFC6901 pointer`)
  return pointer
}
function safeUrl(value: unknown, label: string, allowHttpLoopback: boolean): string {
  const raw = string(value, label)
  if (/\{[^}]*\}/u.test(raw)) fail(`${label} must not contain placeholders`)
  let url: URL
  try { url = new URL(raw) } catch { fail(`${label} must be an absolute URL`) }
  if (url.username !== '' || url.password !== '' || url.hash !== '') fail(`${label} must not contain credentials or a fragment`)
  if (url.protocol === 'https:') return url.toString()
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.protocol !== 'http:' || !allowHttpLoopback || !loopback) fail(`${label} must use HTTPS or explicitly enabled loopback HTTP`)
  return url.toString()
}
function readbackTemplate(value: unknown, allowHttpLoopback: boolean): string {
  const raw = string(value, 'readback urlTemplate'); const marker = '__dsh_acceptance_object_id__'
  if ((raw.match(/\{id\}/gu) ?? []).length !== 1) fail('readback urlTemplate must contain exactly one {id}')
  if (/\{[^}]*\}/u.test(raw.replace('{id}', ''))) fail('readback urlTemplate must not contain other placeholders')
  const parsed = new URL(safeUrl(raw.replace('{id}', marker), 'readback urlTemplate', allowHttpLoopback))
  if (parsed.hostname.includes(marker) || parsed.search.includes(marker) || parsed.username.includes(marker)
    || parsed.password.includes(marker) || !parsed.pathname.split('/').includes(marker)) {
    fail('readback urlTemplate must contain {id} as one path segment')
  }
  return parsed.toString().replace(marker, '{id}')
}
function shaFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size < 0 || stat.size > MAX_EXECUTABLE_BYTES) fail('runner executable must be a bounded regular file')
    const bytes = Buffer.alloc(stat.size); let offset = 0
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (count === 0) break; offset += count }
    const after = fstatSync(fd)
    if (offset !== stat.size || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) fail('runner executable changed while hashing')
    return createHash('sha256').update(bytes).digest('hex')
  } finally { closeSync(fd) }
}
function canonicalDirectory(value: unknown, label: string): string {
  const path = string(value, label)
  if (!isAbsolute(path) || normalize(path) !== path || resolve(path) !== path || path === sep) fail(`${label} must be a canonical non-root absolute path`)
  return path
}
function canonicalExecutable(value: unknown, label: string): string {
  const configured = string(value, label)
  if (!isAbsolute(configured) || normalize(configured) !== configured || resolve(configured) !== configured) fail(`${label} must be a canonical absolute path`)
  let resolved: string
  try { resolved = realpathSync(configured) } catch { fail(`${label} is unavailable`) }
  if (resolved !== configured) fail(`${label} must not traverse a symlink`)
  try {
    const stat = statSync(resolved)
    if (!stat.isFile() || (stat.mode & 0o111) === 0) fail(`${label} must be an executable regular file`)
  } catch (error) {
    if (error instanceof VerifierAuthorityError) throw error
    fail(`${label} is unavailable`)
  }
  return resolved
}
function strictArray(value: unknown, label: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minimum || value.length > maximum || Object.getOwnPropertySymbols(value).length > 0) fail(`${label} must be bounded`)
  const keys = Object.getOwnPropertyNames(value).filter(key => key !== 'length')
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) fail(`${label} has an unsafe shape`)
  return value
}
function isolatedTestSets(value: unknown): readonly IsolatedRunnerTestSetInput[] {
  const sets = strictArray(value, 'isolated runner testSets', 1, MAX_ISOLATED_TEST_SETS)
  const ids = new Set<string>(); let cases = 0; let bytes = 0
  const output = sets.map((entry, index) => {
    const set = object(entry, `isolated runner testSets[${index}]`); exactKeys(set, ['id', 'cases'], 'isolated runner test set')
    const id = string(set.id, 'isolated runner test set id')
    if (ids.has(id)) fail('isolated runner test set ids must be unique'); ids.add(id)
    const casesInput = strictArray(set.cases, 'isolated runner test cases', 1, MAX_ISOLATED_CASES)
    const parsed = casesInput.map((candidate, caseIndex) => {
      cases += 1; if (cases > MAX_ISOLATED_TEST_CASES) fail('isolated runner test cases exceed total bound')
      const item = object(candidate, `isolated runner testSets[${index}].cases[${caseIndex}]`)
      exactKeys(item, ['stdin', 'expectedStdout', 'expectedExitCode'], 'isolated runner test case')
      const stdin = string(item.stdin, 'isolated runner stdin', true)
      const expectedStdout = string(item.expectedStdout, 'isolated runner expectedStdout', true)
      bytes += Buffer.byteLength(stdin, 'utf8') + Buffer.byteLength(expectedStdout, 'utf8')
      if (bytes > MAX_ISOLATED_TEST_BYTES) fail('isolated runner test text exceeds total bound')
      const expectedExitCode = item.expectedExitCode
      if (typeof expectedExitCode !== 'number' || !Number.isSafeInteger(expectedExitCode) || expectedExitCode < 0 || expectedExitCode > 255) fail('isolated runner expectedExitCode is invalid')
      return freeze({ stdin, expectedStdout, expectedExitCode })
    })
    return freeze({ id, cases: freeze(parsed) })
  })
  return freeze(output)
}

/** Validates Host-owned driver configuration, captures executable identity, and freezes it. */
export function createVerifierAuthorities(config: unknown): readonly VerifierAuthority[] {
  const root = object(config, 'verifier authorities'); exactKeys(root, ['authorities'], 'verifier authorities')
  if (!Array.isArray(root.authorities) || root.authorities.length === 0 || root.authorities.length > MAX_AUTHORITIES) fail('authorities must be a bounded non-empty array')
  const identifiers = new Set<string>()
  const authorities = root.authorities.map((entry, index): VerifierAuthority => {
    const item = object(entry, `authorities[${index}]`); const kind = string(item.kind, `authorities[${index}].kind`)
    const id = string(item.id, `authorities[${index}].id`)
    if (identifiers.has(`${kind}\0${id}`)) fail('authority kind/id must be unique')
    identifiers.add(`${kind}\0${id}`)
    if (kind === 'runner') {
      allowedKeys(item, ['kind', 'id', 'executable', 'fixedArgs', 'timeoutMs', 'maxOutputBytes'], ['environment'], `runner authority ${id}`)
      const executable = string(item.executable, 'runner executable')
      if (!isAbsolute(executable) || normalize(executable) !== executable) fail('runner executable must be an absolute normalized path')
      if (!Array.isArray(item.fixedArgs) || item.fixedArgs.length > 64) fail('runner fixedArgs must be bounded')
      const fixedArgs = item.fixedArgs.map((value, arg) => string(value, `runner fixedArgs[${arg}]`, true))
      const environmentValue = item.environment === undefined ? {} : object(item.environment, 'runner environment')
      const environment: Record<string, string> = {}
      for (const [key, value] of Object.entries(environmentValue)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) fail('runner environment key is invalid')
        environment[key] = string(value, `runner environment.${key}`, true)
      }
      const bare = { kind: 'runner' as const, id, executable, fixedArgs, timeoutMs: whole(item.timeoutMs, 'runner timeoutMs'), maxOutputBytes: whole(item.maxOutputBytes, 'runner maxOutputBytes', 1_048_576), environment, executableDigest: shaFile(executable) }
      return freeze({ ...bare, digest: digest(bare) })
    }
    if (kind === 'document') {
      allowedKeys(item, ['kind', 'id', 'sources', 'timeoutMs', 'maxResponseBytes'], ['allowHttpLoopback'], `document authority ${id}`)
      if (!Array.isArray(item.sources) || item.sources.length === 0 || item.sources.length > 64) fail('document sources must be bounded and non-empty')
      if (item.allowHttpLoopback !== undefined && typeof item.allowHttpLoopback !== 'boolean') fail('document allowHttpLoopback must be boolean')
      const allowHttpLoopback = item.allowHttpLoopback === true
      const sourceIds = new Set<string>(); const sources = item.sources.map((source, sourceIndex) => {
        const row = object(source, `document sources[${sourceIndex}]`); exactKeys(row, ['id', 'url'], 'document source')
        const sourceId = string(row.id, 'document source id'); if (sourceIds.has(sourceId)) fail('document source id must be unique'); sourceIds.add(sourceId)
        return freeze({ id: sourceId, url: safeUrl(row.url, 'document source url', allowHttpLoopback) })
      })
      const bare = { kind: 'document' as const, id, sources, timeoutMs: whole(item.timeoutMs, 'document timeoutMs'), maxResponseBytes: whole(item.maxResponseBytes, 'document maxResponseBytes', 1_048_576), allowHttpLoopback }
      return freeze({ ...bare, digest: digest(bare) })
    }
    if (kind === 'readback') {
      allowedKeys(item, ['kind', 'id', 'urlTemplate', 'objectIdPointer', 'timeoutMs', 'maxResponseBytes'], ['revisionPointer', 'allowHttpLoopback'], `readback authority ${id}`)
      if (item.allowHttpLoopback !== undefined && typeof item.allowHttpLoopback !== 'boolean') fail('readback allowHttpLoopback must be boolean')
      const allowHttpLoopback = item.allowHttpLoopback === true
      const urlTemplate = readbackTemplate(item.urlTemplate, allowHttpLoopback)
      const revisionPointer = item.revisionPointer === undefined ? undefined : validPointer(item.revisionPointer, 'readback revisionPointer')
      const bare = { kind: 'readback' as const, id, urlTemplate, objectIdPointer: validPointer(item.objectIdPointer, 'readback objectIdPointer'), ...(revisionPointer === undefined ? {} : { revisionPointer }), timeoutMs: whole(item.timeoutMs, 'readback timeoutMs'), maxResponseBytes: whole(item.maxResponseBytes, 'readback maxResponseBytes', 1_048_576), allowHttpLoopback }
      return freeze({ ...bare, digest: digest(bare) })
    }
    if (kind === 'repository-readback') {
      exactKeys(item, ['kind', 'id', 'grantId', 'grantRevision', 'repository', 'branch', 'baseBranch', 'requiredChecks', 'reviewerIds', 'minApprovals', 'timeoutMs', 'freshnessMs'], 'repository readback authority')
      const checks = strictArray(item.requiredChecks, 'required checks', 1, 20).map(value => {
        const check = object(value, 'required check'); exactKeys(check, ['name', 'appId'], 'required check')
        const name = string(check.name, 'check name')
        if (name.length > 256 || name.trim() !== name || /[\p{Cc}]/u.test(name)) fail('invalid check name')
        return { name, appId: whole(check.appId, 'check app id', Number.MAX_SAFE_INTEGER) }
      })
      if (new Set(checks.map(check => JSON.stringify(check))).size !== checks.length) fail('duplicate required check')
      const reviewerIds = strictArray(item.reviewerIds, 'reviewer ids', 0, 30).map(value => whole(value, 'reviewer id', Number.MAX_SAFE_INTEGER))
      if (new Set(reviewerIds).size !== reviewerIds.length || !Number.isSafeInteger(item.minApprovals) || (item.minApprovals as number) < 0 || (item.minApprovals as number) > reviewerIds.length) fail('invalid required approvals')
      const repository = string(item.repository, 'repository'), branch = string(item.branch, 'branch'), baseBranch = string(item.baseBranch, 'baseBranch')
      if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(repository) || branch === baseBranch
        || `${repository}:${branch}`.length > 256 || [branch, baseBranch].some(value => value.length > 256 || value.trim() !== value || /[\p{Cc}]/u.test(value))) fail('invalid repository target')
      const bare = { kind: 'repository-readback' as const, id, grantId: string(item.grantId, 'grantId'), grantRevision: whole(item.grantRevision, 'grant revision', Number.MAX_SAFE_INTEGER), repository, branch, baseBranch, requiredChecks: checks, reviewerIds, minApprovals: item.minApprovals as number, timeoutMs: whole(item.timeoutMs, 'repository timeout', 30_000), freshnessMs: whole(item.freshnessMs, 'repository freshness', 60_000) }
      return freeze({ ...bare, digest: digest(bare) })
    }
    if (kind === 'isolated-runner') {
      allowedKeys(item, ['kind', 'id', 'stateRoot', 'image', 'dockerPath', 'command', 'expiresAt', 'maxRuns', 'maxTotalDurationMs', 'maxDurationMs', 'maxOutputBytes', 'testSets'], [], `isolated runner authority ${id}`)
      const image = string(item.image, 'isolated runner image')
      if (!IMAGE.test(image)) fail('isolated runner image must be SHA-256 pinned')
      const expiresAt = item.expiresAt
      if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt < 1) fail('isolated runner expiresAt must be an absolute timestamp')
      const maxTotalDurationMs = whole(item.maxTotalDurationMs, 'isolated runner maxTotalDurationMs', 86_400_000)
      const maxDurationMs = whole(item.maxDurationMs, 'isolated runner maxDurationMs', 300_000)
      if (maxDurationMs > maxTotalDurationMs) fail('isolated runner maxDurationMs must not exceed maxTotalDurationMs')
      const bare = { kind: 'isolated-runner' as const, id, stateRoot: canonicalDirectory(item.stateRoot, 'isolated runner stateRoot'), image,
        dockerPath: canonicalExecutable(item.dockerPath, 'isolated runner dockerPath'), command: string(item.command, 'isolated runner command'), expiresAt,
        maxRuns: whole(item.maxRuns, 'isolated runner maxRuns', 10_000), maxTotalDurationMs, maxDurationMs,
        maxOutputBytes: whole(item.maxOutputBytes, 'isolated runner maxOutputBytes', 262_144), testSets: isolatedTestSets(item.testSets) }
      return freeze({ ...bare, digest: digest(bare) })
    }
    return fail(`unknown authority kind ${kind}`)
  })
  return freeze(authorities)
}

function unknown(criterionId: string, reason: string, artifactDigest?: string): CriterionResult {
  return freeze({ criterionId, status: 'unknown', reason, evidence: [], ...(artifactDigest === undefined ? {} : { artifactDigest }) })
}
function failed(criterionId: string, reason: string, evidence: CriterionResult['evidence'] = [], artifactDigest?: string): CriterionResult {
  return freeze({ criterionId, status: 'failed', reason, evidence, ...(artifactDigest === undefined ? {} : { artifactDigest }) })
}
function passed(criterionId: string, evidence: CriterionResult['evidence'], artifactDigest?: string): CriterionResult {
  return freeze({ criterionId, status: 'passed', reason: 'verified', evidence, ...(artifactDigest === undefined ? {} : { artifactDigest }) })
}
function authorityFor(criterion: AcceptanceCriterion, authorities: readonly VerifierAuthority[]): VerifierAuthority | undefined {
  return authorities.find(authority => authority.id === criterion.authority.id && authority.digest === criterion.authority.digest)
}
async function artifact(workspace: string, path: string, signal: AbortSignal): Promise<{ path: string; digest: string; bytes: Buffer }> {
  if (signal.aborted) throw new Error('artifact-aborted')
  if (!path || isAbsolute(path) || normalize(path) !== path || path.split(/[\\/]/u).includes('..')) throw new Error('artifact-path-invalid')
  const canonicalWorkspace = await realpath(workspace); const candidate = resolve(canonicalWorkspace, path)
  if (relative(canonicalWorkspace, candidate) === '' || !candidate.startsWith(canonicalWorkspace + sep)) throw new Error('artifact-path-escape')
  const parts = relative(canonicalWorkspace, candidate).split(sep); let current = canonicalWorkspace
  for (const part of parts) { current = resolve(current, part); if ((await lstat(current)).isSymbolicLink()) throw new Error('artifact-symlink') }
  const resolved = await realpath(candidate)
  if (!resolved.startsWith(canonicalWorkspace + sep)) throw new Error('artifact-path-escape')
  // lstat each segment after realpath so a symlink cannot enter the workspace.
  current = canonicalWorkspace
  for (const part of parts) { current = resolve(current, part); const stat = await lstat(current); if (stat.isSymbolicLink()) throw new Error('artifact-symlink') }
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size < 0 || stat.size > MAX_ARTIFACT_BYTES) throw new Error('artifact-not-regular-or-oversize')
    const bytes = Buffer.alloc(stat.size); let offset = 0
    while (offset < bytes.length) { if (signal.aborted) throw new Error('artifact-aborted'); const reading = await handle.read(bytes, offset, bytes.length - offset, offset); if (reading.bytesRead === 0) break; offset += reading.bytesRead }
    const after = await handle.stat()
    if (offset !== stat.size || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) throw new Error('artifact-altered')
    return { path: resolved, bytes, digest: createHash('sha256').update(bytes).digest('hex') }
  } finally { await handle.close().catch(() => {}) }
}
async function snapshotArtifact(bytes: Buffer, originalPath: string): Promise<{ path: string; remove(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-verifier-snapshot-'))
  const path = join(directory, `artifact${extname(originalPath)}`)
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o400 })
    await chmod(path, 0o400)
    return { path, remove: async () => { await rm(directory, { recursive: true, force: true }) } }
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
function pointer(document: unknown, value: string): unknown {
  let current = document
  if (value === '') return current
  for (const token of value.slice(1).split('/')) {
    const key = token.replace(/~1/gu, '/').replace(/~0/gu, '~')
    if (key === '__proto__' || key === 'constructor' || key === 'prototype' || typeof current !== 'object' || current === null || !Object.hasOwn(current, key)) throw new Error('json-pointer-missing')
    current = (current as Record<string, unknown>)[key]
  }
  return current
}
async function responseBytes(url: string, maximum: number, signal: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, { method: 'GET', redirect: 'error', signal, headers: { accept: 'application/json,text/plain' } })
  if (!response.ok || response.body === null) throw new Error('http-response-invalid')
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > maximum) { await response.body.cancel().catch(() => {}); throw new Error('http-body-oversize') }
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0
  try {
    while (true) { const entry = await reader.read(); if (entry.done) break; size += entry.value.byteLength; if (size > maximum) throw new Error('http-body-oversize'); chunks.push(Buffer.from(entry.value)) }
  } finally { await reader.cancel().catch(() => {}) }
  return Buffer.concat(chunks, size)
}
function withDeadline(parent: AbortSignal, duration: number): { signal: AbortSignal; close(): void } {
  const controller = new AbortController(); const abort = () => controller.abort(parent.reason)
  if (parent.aborted) abort(); else parent.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('verification-timeout')), duration); timer.unref?.()
  return { signal: controller.signal, close: () => { clearTimeout(timer); parent.removeEventListener('abort', abort) } }
}
async function run(authority: RunnerAuthority, input: string, artifactPath: string, workspace: string, signal: AbortSignal): Promise<{ code: number | null; stdout: Buffer; timedOut: boolean; oversize: boolean }> {
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) { resolvePromise({ code: null, stdout: Buffer.alloc(0), timedOut: true, oversize: false }); return }
    const grouped = process.platform !== 'win32'
    const child = spawn(authority.executable, [...authority.fixedArgs, artifactPath], { cwd: workspace, env: { ...authority.environment }, shell: false, detached: grouped, stdio: ['pipe', 'pipe', 'ignore'] })
    const output: Buffer[] = []; let size = 0; let oversize = false; let timedOut = false; let settled = false
    const releasePipes = () => {
      child.stdin?.destroy()
      child.stdout?.destroy()
    }
    const terminate = (timeout = true) => {
      if (timeout) timedOut = true
      try { if (grouped && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { child.kill('SIGKILL') }
    }
    const settle = (result: { code: number | null; stdout: Buffer; timedOut: boolean; oversize: boolean }) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      releasePipes()
      resolvePromise(result)
    }
    const onAbort = () => { terminate(); settle({ code: null, stdout: Buffer.concat(output), timedOut, oversize }) }
    const finishError = (error: Error) => { if (settled) return; settled = true; signal.removeEventListener('abort', onAbort); terminate(); releasePipes(); reject(error) }
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true })
    child.stdout!.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > authority.maxOutputBytes) { oversize = true; terminate(false); settle({ code: null, stdout: Buffer.concat(output), timedOut, oversize }) } else output.push(chunk)
    })
    child.once('error', error => finishError(error))
    child.once('close', code => settle({ code, stdout: Buffer.concat(output), timedOut, oversize }))
    child.stdin!.once('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') finishError(error) })
    child.stdin!.end(input, 'utf8')
  })
}

async function verifyProcess(criterion: ProcessBehaviorCriterion, authority: RunnerAuthority, workspace: string, signal: AbortSignal): Promise<CriterionResult> {
  let initial: { path: string; digest: string; bytes: Buffer }
  try { initial = await artifact(workspace, criterion.artifactPath, signal) } catch { return unknown(criterion.id, 'artifact-unavailable') }
  try {
    if (shaFile(authority.executable) !== authority.executableDigest) return unknown(criterion.id, 'executable-identity-mismatch', initial.digest)
  } catch { return unknown(criterion.id, 'executable-unavailable', initial.digest) }
  const deadline = withDeadline(signal, authority.timeoutMs)
  let snapshot: { path: string; remove(): Promise<void> } | undefined
  try {
    // This is a one-artifact byte snapshot. The original workspace remains cwd, but imports resolved from the artifact path use the temporary snapshot location.
    snapshot = await snapshotArtifact(initial.bytes, initial.path)
    const result = await run(authority, criterion.stdin, snapshot.path, workspace, deadline.signal)
    const final = await artifact(workspace, criterion.artifactPath, signal).catch(() => undefined)
    if (final === undefined || final.digest !== initial.digest) return unknown(criterion.id, 'artifact-altered', initial.digest)
    if (deadline.signal.aborted) return unknown(criterion.id, 'verification-aborted', initial.digest)
    if (result.oversize) return unknown(criterion.id, 'process-output-oversize', initial.digest)
    if (result.timedOut) return unknown(criterion.id, 'process-timeout', initial.digest)
    if (result.code !== criterion.expectedExitCode) return failed(criterion.id, 'unexpected-exit-code', [], initial.digest)
    if (result.stdout.toString('utf8') !== criterion.expectedStdout) return failed(criterion.id, 'unexpected-stdout', [], initial.digest)
    return passed(criterion.id, [{ kind: 'process-output', ref: criterion.artifactPath, digest: createHash('sha256').update(result.stdout).digest('hex') }], initial.digest)
  } catch { return unknown(criterion.id, signal.aborted ? 'verification-aborted' : 'process-io-failed', initial.digest) } finally { deadline.close(); await snapshot?.remove() }
}
async function verifyDocument(criterion: DocumentCitationsCriterion, authority: DocumentAuthority, workspace: string, signal: AbortSignal): Promise<CriterionResult> {
  let target: { path: string; digest: string; bytes: Buffer }
  try { target = await artifact(workspace, criterion.artifactPath, signal) } catch { return unknown(criterion.id, 'artifact-unavailable') }
  const text = target.bytes.toString('utf8'); let outcome: CriterionResult | undefined
  if (criterion.requiredText.some(required => !text.includes(required))) outcome = failed(criterion.id, 'required-text-missing', [], target.digest)
  const deadline = withDeadline(signal, authority.timeoutMs)
  try {
    const evidence: Array<{ kind: string; ref: string; digest: string }> = []
    for (const quote of criterion.quotes) {
      if (outcome !== undefined) break
      const source = authority.sources.find(item => item.id === quote.sourceId)
      if (source === undefined || !text.includes(quote.quote) || !text.includes(source.url)) { outcome = failed(criterion.id, 'citation-missing', evidence, target.digest); break }
      const body = await responseBytes(source.url, authority.maxResponseBytes, deadline.signal)
      const observed = createHash('sha256').update(body).digest('hex')
      if (observed !== quote.sourceSha256 || !body.toString('utf8').includes(quote.quote)) { outcome = failed(criterion.id, 'citation-mismatch', evidence, target.digest); break }
      evidence.push({ kind: 'source', ref: source.url, digest: observed })
    }
    const final = await artifact(workspace, criterion.artifactPath, signal).catch(() => undefined)
    if (final === undefined || final.digest !== target.digest) return unknown(criterion.id, 'artifact-altered', target.digest)
    if (deadline.signal.aborted) return unknown(criterion.id, 'verification-aborted', target.digest)
    return outcome ?? passed(criterion.id, evidence, target.digest)
  } catch { return unknown(criterion.id, signal.aborted ? 'verification-aborted' : 'source-io-failed', target.digest) } finally { deadline.close() }
}
async function verifyReadback(criterion: TargetReadbackCriterion, authority: ReadbackAuthority, signal: AbortSignal): Promise<CriterionResult> {
  const deadline = withDeadline(signal, authority.timeoutMs)
  try {
    const url = authority.urlTemplate.replace('{id}', encodeURIComponent(criterion.objectId).replace(/\./gu, '%2E'))
    const body = await responseBytes(url, authority.maxResponseBytes, deadline.signal)
    const document: unknown = JSON.parse(body.toString('utf8'))
    acceptanceCanonicalJson(document)
    if (pointer(document, authority.objectIdPointer) !== criterion.objectId) return failed(criterion.id, 'readback-object-mismatch')
    if (criterion.expectedRevision !== undefined && (authority.revisionPointer === undefined || pointer(document, authority.revisionPointer) !== criterion.expectedRevision)) return failed(criterion.id, 'readback-revision-mismatch')
    for (const expected of criterion.expected) if (acceptanceCanonicalJson(pointer(document, expected.pointer)) !== acceptanceCanonicalJson(expected.value)) return failed(criterion.id, 'readback-value-mismatch')
    if (deadline.signal.aborted) return unknown(criterion.id, 'verification-aborted')
    return passed(criterion.id, [{ kind: 'readback', ref: url, digest: createHash('sha256').update(body).digest('hex') }])
  } catch { return unknown(criterion.id, signal.aborted ? 'verification-aborted' : 'readback-io-failed') } finally { deadline.close() }
}

type IsolatedArtifact = Awaited<ReturnType<IsolatedVerificationContext['readArtifact']>>
function snapshotMatches(source: IsolatedArtifact, criterion: IsolatedProcessBehaviorCriterion): boolean {
  return source.path === criterion.artifactPath
    && typeof source.jobId === 'string' && STABLE_REF.test(source.jobId)
    && typeof source.requestDigest === 'string' && /^[a-f0-9]{64}$/u.test(source.requestDigest)
    && typeof source.content === 'string' && Buffer.byteLength(source.content, 'utf8') <= MAX_ARTIFACT_BYTES
    && typeof source.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(source.sha256)
    && createHash('sha256').update(source.content, 'utf8').digest('hex') === source.sha256
}
function isolatedKey(contract: TaskAcceptanceContract, criterion: IsolatedProcessBehaviorCriterion, source: IsolatedArtifact, authority: IsolatedRunnerAuthority, caseIndex: number): string {
  return createHash('sha256').update(acceptanceCanonicalJson([
    contract.id, contract.digest, criterion.id, source.jobId, source.requestDigest, source.sha256,
    authority.digest, criterion.testSetId, caseIndex,
  ])).digest('hex')
}
async function verifyIsolated(criterion: IsolatedProcessBehaviorCriterion, authority: IsolatedRunnerAuthority, contract: TaskAcceptanceContract, context: IsolatedVerificationContext | undefined, signal: AbortSignal): Promise<CriterionResult> {
  if (context === undefined) return unknown(criterion.id, 'isolated-context-unavailable')
  if (authority.expiresAt <= Date.now()) return unknown(criterion.id, 'isolated-authority-expired')
  const testSet = authority.testSets.find(entry => entry.id === criterion.testSetId)
  if (testSet === undefined) return unknown(criterion.id, 'isolated-test-set-unavailable')
  let initial: IsolatedArtifact
  try { initial = await context.readArtifact(contract, criterion.artifactPath) } catch { return unknown(criterion.id, 'isolated-artifact-unavailable') }
  if (!snapshotMatches(initial, criterion)) return unknown(criterion.id, 'isolated-artifact-invalid')
  const total = withDeadline(signal, Math.min(contract.bounds.maxDurationMs, authority.maxTotalDurationMs))
  let outcome: CriterionResult | undefined
  const runs: Array<{ jobId: string; key: string }> = []
  try {
    for (let index = 0; index < testSet.cases.length; index += 1) {
      if (total.signal.aborted) { outcome = unknown(criterion.id, 'verification-aborted', initial.sha256); break }
      const entry = testSet.cases[index]!
      const deadline = withDeadline(total.signal, authority.maxDurationMs)
      const key = isolatedKey(contract, criterion, initial, authority, index)
      let observed: Awaited<ReturnType<IsolatedVerificationContext['run']>>
      try { observed = await context.run(authority, key, initial.content, entry.stdin, deadline.signal) } catch {
        outcome = unknown(criterion.id, deadline.signal.aborted ? 'verification-aborted' : 'isolated-run-unavailable', initial.sha256)
        deadline.close(); break
      }
      deadline.close()
      if (typeof observed.jobId !== 'string' || !STABLE_REF.test(observed.jobId) || (observed.status !== 'succeeded' && observed.status !== 'failed') || !observed.quiescent) {
        outcome = unknown(criterion.id, 'isolated-run-unknown', initial.sha256); break
      }
      runs.push({ jobId: observed.jobId, key })
      if (typeof observed.stdout !== 'string' || typeof observed.stderr !== 'string'
        || Buffer.byteLength(observed.stdout, 'utf8') > authority.maxOutputBytes || Buffer.byteLength(observed.stderr, 'utf8') > authority.maxOutputBytes) {
        outcome = unknown(criterion.id, 'isolated-output-invalid', initial.sha256); break
      }
      if (!Number.isSafeInteger(observed.exitCode)) { outcome = unknown(criterion.id, 'isolated-exit-unavailable', initial.sha256); break }
      if (observed.exitCode !== entry.expectedExitCode) {
        outcome = failed(criterion.id, 'isolated-unexpected-exit-code', [], initial.sha256); break
      }
      if (observed.stdout !== entry.expectedStdout) {
        outcome = failed(criterion.id, 'isolated-unexpected-stdout', [], initial.sha256); break
      }
    }
    let final: IsolatedArtifact
    try { final = await context.readArtifact(contract, criterion.artifactPath) } catch { return unknown(criterion.id, 'isolated-artifact-unavailable', initial.sha256) }
    if (!snapshotMatches(final, criterion) || final.jobId !== initial.jobId || final.requestDigest !== initial.requestDigest || final.sha256 !== initial.sha256 || final.content !== initial.content) {
      return unknown(criterion.id, 'isolated-artifact-altered', initial.sha256)
    }
    if (total.signal.aborted) return unknown(criterion.id, 'verification-aborted', initial.sha256)
    return outcome ?? passed(criterion.id, [{ kind: 'isolated-artifact', ref: initial.jobId, digest: initial.sha256 },
      { kind: 'isolated-verification-jobs', ref: authority.id, digest: digest(runs) }], initial.sha256)
  } finally { total.close() }
}

async function verifyRepository(criterion: TargetReadbackCriterion, authority: RepositoryReadbackAuthority, contract: TaskAcceptanceContract, context: RepositoryVerificationContext | undefined, signal: AbortSignal): Promise<CriterionResult> {
  if (contract.task.kind !== 'goal-outcome' || criterion.objectId !== `${authority.repository}:${authority.branch}` || context === undefined) return unknown(criterion.id, 'repository-context-unavailable')
  const deadline = withDeadline(signal, authority.timeoutMs)
  try {
    const value = await context.read(contract, authority, deadline.signal)
    const document = object(value, 'repository readback')
    exactKeys(document, ['objectId', 'headOid', 'ci', 'review', 'pullRequest', 'ready'], 'repository readback')
    if (deadline.signal.aborted || document.objectId !== criterion.objectId || typeof document.headOid !== 'string' || !/^[a-f0-9]{40}$/u.test(document.headOid)
      || !['passed', 'pending', 'failed'].includes(document.ci as string) || !['approved', 'pending', 'changes-requested'].includes(document.review as string)
      || !['open', 'closed', 'merged'].includes(document.pullRequest as string)
      || document.ready !== (document.ci === 'passed' && document.review === 'approved' && ['open', 'merged'].includes(document.pullRequest as string))) return unknown(criterion.id, 'repository-readback-unconfirmed')
    if (document.ci === 'pending' || document.review === 'pending') return unknown(criterion.id, 'repository-requirements-pending')
    if (criterion.expectedRevision !== undefined && criterion.expectedRevision !== document.headOid) return failed(criterion.id, 'repository-head-mismatch')
    const evidence = [{ kind: 'repository-readback', ref: criterion.objectId, digest: digest(document) }]
    for (const expected of criterion.expected) if (acceptanceCanonicalJson(pointer(document, expected.pointer)) !== acceptanceCanonicalJson(expected.value)) return failed(criterion.id, 'repository-requirements-not-met', evidence)
    return passed(criterion.id, evidence)
  } catch { return unknown(criterion.id, 'repository-readback-unavailable') } finally { deadline.close() }
}

/** Runs every immutable criterion once. It never retries task side effects. */
export async function verifyAcceptanceCriteria(contract: TaskAcceptanceContract, authorities: readonly VerifierAuthority[], signal: AbortSignal, context?: IsolatedVerificationContext, repository?: RepositoryVerificationContext): Promise<readonly CriterionResult[]> {
  const deadline = withDeadline(signal, contract.bounds.maxDurationMs)
  try {
    const results: CriterionResult[] = []
    for (const criterion of contract.criteria) {
      if (deadline.signal.aborted) { results.push(unknown(criterion.id, 'verification-aborted')); continue }
      const authority = authorityFor(criterion, authorities)
      if (authority === undefined) { results.push(unknown(criterion.id, 'authority-mismatch')); continue }
      if (criterion.kind === 'process-behavior') results.push(authority.kind === 'runner' ? await verifyProcess(criterion, authority, contract.scope.workspace, deadline.signal) : unknown(criterion.id, 'authority-kind-mismatch'))
      else if (criterion.kind === 'isolated-process-behavior') results.push(authority.kind === 'isolated-runner' ? await verifyIsolated(criterion, authority, contract, context, deadline.signal) : unknown(criterion.id, 'authority-kind-mismatch'))
      else if (criterion.kind === 'document-citations') results.push(authority.kind === 'document' ? await verifyDocument(criterion, authority, contract.scope.workspace, deadline.signal) : unknown(criterion.id, 'authority-kind-mismatch'))
      else if (authority.kind === 'repository-readback') results.push(await verifyRepository(criterion, authority, contract, repository, deadline.signal))
      else results.push(authority.kind === 'readback' ? await verifyReadback(criterion, authority, deadline.signal) : unknown(criterion.id, 'authority-kind-mismatch'))
    }
    return freeze(results)
  } finally { deadline.close() }
}
