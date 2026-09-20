import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { assertSourceReviewHead, inspectSourceReviewGit } from './source-review-git.js'
import { SourceReviewStore } from './source-review-store.js'

export interface SourceReviewModelSelection { provider: string; model: string; reasoningEffort?: string }
export type SourceReviewOwnerReceipt = OwnerForegroundLearningTask['owner']
const ownerKeys = ['authorityId', 'authorityHash', 'principalId', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset'] as const
export interface SourceReviewConfig {
  authorityId: string; expiresAt: number; maxReviews: number
  repository: string; git: { path: string; sha256: string }; decisionRoot: string; plugins: readonly string[]
  owner: Pick<SourceReviewOwnerReceipt, typeof ownerKeys[number]>
  reviewerPrincipal: string; policy: string; maxChangedFiles: number; maxInputBytes: number
  maxOutputTokens: number; timeoutMs: number; model?: SourceReviewModelSelection
}
export interface SourceReviewRequest {
  protocol: 'dsh-source-review/v1'; operationId: string; planId: string; planDigest: string
  releaseId: string; fence: number; revision: number; name: string
  baseCommit: string; headCommit: string; prId: string; prEvidenceDigest: string
  checkedTreeDigest: string; checkedPatchDigest: string; scope: readonly string[]
  source: { owner: SourceReviewOwnerReceipt; outcomeId: string; sourceDigest: string; objective: string; modelSelection?: SourceReviewModelSelection }
}
export interface SourceReviewResult {
  status: 'approved' | 'rejected' | 'unknown'; operationId: string; requestDigest: string
  sessionId: string; reason: string; model: SourceReviewModelSelection; outputDigest?: string
}
export interface SourceReviewInput {
  request: SourceReviewRequest; signal?: AbortSignal; withSourceFence<T>(callback: () => T): T
}
export interface SourceReviewSelection {
  decisionRoot: string; owner: SourceReviewOwnerReceipt; name: string
  modelSelection?: SourceReviewModelSelection; operationId?: string
}
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u
const shaPattern = /^[a-f0-9]{64}$/u
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))
    || required.some(key => !Object.hasOwn(value, key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !item.enumerable || !('value' in item))) throw new Error('source review invalid object')
}
function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > max) throw new Error('source review invalid text')
}
function id(value: unknown): void { text(value, 256); if (!idPattern.test(value)) throw new Error('source review invalid identity') }
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER, min = 1): void {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error('source review invalid bound')
}
function path(value: unknown): asserts value is string {
  text(value, 4096); if (!isAbsolute(value) || value === '/' || resolve(value) !== value) throw new Error('source review invalid path')
}
function sha(value: unknown): void { if (typeof value !== 'string' || !shaPattern.test(value)) throw new Error('source review invalid digest') }
function model(value: SourceReviewModelSelection): void {
  exact(value, ['provider', 'model'], ['reasoningEffort']); id(value.provider); id(value.model)
  if (value.reasoningEffort !== undefined) id(value.reasoningEffort)
}
function owner(value: SourceReviewConfig['owner']): void {
  for (const key of ['authorityId', 'principalId', 'principalRecordId', 'agentPreset'] as const) id(value[key])
  sha(value.authorityHash); integer(value.principalVersion); path(value.workspace)
}
function privateRoot(root: string): void {
  path(root)
  const stat = lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077
    || process.getuid && stat.uid !== process.getuid() || realpathSync(root) !== root) throw new Error('source review decision directory must be private and canonical')
}
export function validateSourceReviewConfig(value: SourceReviewConfig): SourceReviewConfig {
  exact(value, ['authorityId', 'expiresAt', 'maxReviews', 'repository', 'git', 'decisionRoot', 'plugins', 'owner', 'reviewerPrincipal',
    'policy', 'maxChangedFiles', 'maxInputBytes', 'maxOutputTokens', 'timeoutMs'], ['model'])
  id(value.authorityId); integer(value.expiresAt); integer(value.maxReviews, 10_000)
  path(value.repository); exact(value.git, ['path', 'sha256']); path(value.git.path); sha(value.git.sha256)
  privateRoot(value.decisionRoot); exact(value.owner, ownerKeys); owner(value.owner)
  id(value.reviewerPrincipal); text(value.policy, 16_384)
  integer(value.maxChangedFiles, 1000); integer(value.maxInputBytes, 2_097_152, 4096)
  integer(value.maxOutputTokens, 32_768); integer(value.timeoutMs, 1_800_000, 1000)
  if (!Array.isArray(value.plugins) || value.plugins.length === 0 || value.plugins.length > 64
    || new Set(value.plugins).size !== value.plugins.length || value.plugins.some(name => !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(name))) throw new Error('source review invalid plugin scope')
  if (value.model !== undefined) model(value.model)
  return structuredClone(value)
}
function validateRequest(value: SourceReviewRequest, config: SourceReviewConfig): void {
  exact(value, ['protocol', 'operationId', 'planId', 'planDigest', 'releaseId', 'fence', 'revision', 'name', 'baseCommit', 'headCommit',
    'prId', 'prEvidenceDigest', 'checkedTreeDigest', 'checkedPatchDigest', 'scope', 'source'])
  if (value.protocol !== 'dsh-source-review/v1') throw new Error('source review invalid protocol')
  for (const key of ['operationId', 'planId', 'releaseId'] as const) id(value[key])
  if (typeof value.prId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(value.prId)) throw new Error('source review invalid PR')
  for (const key of ['planDigest', 'prEvidenceDigest', 'checkedTreeDigest', 'checkedPatchDigest'] as const) sha(value[key])
  integer(value.fence); integer(value.revision)
  for (const key of ['baseCommit', 'headCommit'] as const) if (!/^[a-f0-9]{40}$/u.test(value[key])) throw new Error('source review invalid commit')
  if (!config.plugins.includes(value.name) || !Array.isArray(value.scope) || value.scope.length !== 1 || value.scope[0] !== `plugins/${value.name}`) throw new Error('source review outside grant scope')
  exact(value.source, ['owner', 'outcomeId', 'sourceDigest', 'objective'], ['modelSelection'])
  exact(value.source.owner, [...ownerKeys, 'receiptVersion', 'bindingVersion', 'generation']); owner(value.source.owner)
  if (value.source.owner.receiptVersion !== 2 || ownerKeys.some(key => value.source.owner[key] !== config.owner[key])) throw new Error('source review owner changed')
  integer(value.source.owner.bindingVersion); integer(value.source.owner.generation)
  id(value.source.outcomeId); sha(value.source.sourceDigest); text(value.source.objective, 65_536)
  if (value.source.modelSelection !== undefined) model(value.source.modelSelection)
}

/** Host-only immutable writer. The model never receives a filesystem capability. */
function writeDecision(config: SourceReviewConfig, request: SourceReviewRequest): void {
  privateRoot(config.decisionRoot)
  const decision = { schemaVersion: 1, kind: 'dsh-local-review-decision', prId: request.prId,
    baseCommit: request.baseCommit, headCommit: request.headCommit, prEvidenceDigest: request.prEvidenceDigest,
    decision: 'approved', reviewerPrincipal: config.reviewerPrincipal }
  const destination = join(config.decisionRoot, `${request.prId}.json`)
  const verifyExisting = () => {
    const stat = lstatSync(destination)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 8192
      || process.getuid && stat.uid !== process.getuid()) throw new Error('source review unsafe existing decision')
    const fd = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = fstatSync(fd)
      if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('source review decision replaced')
      if (acceptanceCanonicalJson(JSON.parse(readFileSync(fd, 'utf8'))) !== acceptanceCanonicalJson(decision)) throw new Error('source review decision conflict')
    } finally { closeSync(fd) }
  }
  const temporary = join(config.decisionRoot, `.review-${randomUUID()}`)
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, JSON.stringify(decision) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
  try {
    try { linkSync(temporary, destination) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      verifyExisting()
    }
  } finally { unlinkSync(temporary) }
  const directory = openSync(config.decisionRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

/** Lifetime belongs to the injected Fiber; close aborts and drains before DB close. */
export class SourceReviewRuntime {
  readonly #config: SourceReviewConfig
  readonly #store: SourceReviewStore
  readonly #controller = new AbortController()
  readonly #flights = new Set<Promise<SourceReviewResult>>()
  #closing: Promise<void> | undefined
  constructor(private readonly ctx: Context, config: SourceReviewConfig, databasePath: string) {
    this.#config = validateSourceReviewConfig(config)
    this.#store = new SourceReviewStore(databasePath + '.source-reviews')
  }
  available(input: SourceReviewSelection): boolean {
    const config = this.#config
    return !this.#controller.signal.aborted && config.expiresAt > Date.now() && input.decisionRoot === config.decisionRoot
      && input.owner.receiptVersion === 2 && ownerKeys.every(key => input.owner[key] === config.owner[key])
      && config.plugins.includes(input.name) && (config.model !== undefined || input.modelSelection !== undefined)
      && this.#store.available({ authorityId: config.authorityId, authorityDigest: acceptanceDigest(config), maxReviews: config.maxReviews,
        ...(input.operationId === undefined ? {} : { operationId: input.operationId }) })
  }
  run(input: SourceReviewInput): Promise<SourceReviewResult> {
    this.#controller.signal.throwIfAborted()
    const operation = this.#run(input)
    this.#flights.add(operation)
    void operation.finally(() => this.#flights.delete(operation)).catch(() => {})
    return operation
  }
  async #run(input: SourceReviewInput): Promise<SourceReviewResult> {
    const config = this.#config
    validateRequest(input.request, config)
    const request = structuredClone(input.request), selected = structuredClone(config.model ?? request.source.modelSelection)
    if (!selected) throw new Error('source review requires a frozen task model or explicit fixed model')
    const signal = AbortSignal.any([this.#controller.signal, AbortSignal.timeout(config.timeoutMs), ...(input.signal ? [input.signal] : [])])
    const assertLive = () => {
      signal.throwIfAborted()
      if (Date.now() >= config.expiresAt) throw new Error('source review grant expired')
    }
    const assertCurrent = () => { assertLive(); input.withSourceFence(() => {}) }
    assertCurrent()
    const requestDigest = acceptanceDigest(request), authorityDigest = acceptanceDigest(config)
    const gitRequest = { name: request.name, baseCommit: request.baseCommit, headCommit: request.headCommit, prId: request.prId,
      scope: request.scope, checkedTreeDigest: request.checkedTreeDigest, checkedPatchDigest: request.checkedPatchDigest }
    const gitConfig = { repository: config.repository, git: config.git, maxChangedFiles: config.maxChangedFiles, maxInputBytes: config.maxInputBytes }
    // Git inspection completes before reserving a model call; no DB transaction crosses an await.
    const context = await inspectSourceReviewGit(gitConfig, gitRequest, signal)
    const claim = input.withSourceFence(() => {
      assertLive(); assertSourceReviewHead(gitConfig, gitRequest)
      return this.#store.claim({ operationId: request.operationId, requestDigest, authorityId: config.authorityId,
        authorityDigest, maxReviews: config.maxReviews, model: selected })
    })
    const base = { operationId: request.operationId, requestDigest, model: selected, sessionId: `source-review-${requestDigest.slice(0, 40)}` }
    if (claim.state === 'unknown') return { ...base, status: 'unknown', reason: 'Previous review has no durable terminal result; model call will not be repeated.' }
    if (claim.state === 'approved' || claim.state === 'rejected') {
      if (claim.state === 'approved') input.withSourceFence(() => { assertLive(); assertSourceReviewHead(gitConfig, gitRequest); writeDecision(config, request) })
      return { ...base, status: claim.state, ...claim.result! }
    }
    try {
      const { runNativeSourceReview } = await import('./source-review-native.js')
      assertCurrent()
      const result = await runNativeSourceReview(this.ctx, { config, request, model: selected, ...context, signal, assertCurrent })
      await inspectSourceReviewGit(gitConfig, gitRequest, signal)
      input.withSourceFence(() => {
        assertLive(); assertSourceReviewHead(gitConfig, gitRequest)
        this.#store.finish(request.operationId, requestDigest, result)
        if (result.status === 'approved') writeDecision(config, request)
      })
      return { ...base, ...result }
    } catch {
      return { ...base, status: 'unknown', reason: 'Review did not produce an admissible durable decision; inspect the Host review session before reconciliation.' }
    }
  }
  close(): Promise<void> {
    return this.#closing ??= (async () => {
      this.#controller.abort(new Error('source reviewer disposed'))
      await Promise.allSettled(this.#flights); this.#store.close()
    })()
  }
}
