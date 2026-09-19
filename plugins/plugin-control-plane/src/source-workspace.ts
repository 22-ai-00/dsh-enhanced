import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { ControlPlaneCliError } from './errors.js'
import type { ControlPlaneStore } from './store.js'
import type { PluginSourcePlan } from './types.js'

// 工程层、非真实供应商证据：本模块产出的 prepared evidence 只来自隔离
// worktree 内实际执行的 frozen 构建命令与 git 快照摘要；假 pnpm 壳仅可在
// 测试中经 PATH 注入，测试名与注释须标注工程层用途。

const pluginCatalogScope = 'plugins/README.md'

/**
 * Modify plans in these statuses still own a prepared worktree that nobody else
 * can act on; once their TTL expires the worktree is garbage. Plans in any
 * later status (ready-for-human-review and beyond) are left for the owner's
 * release workflow regardless of TTL.
 */
const GC_ELIGIBLE_SOURCE_STATUSES: ReadonlySet<string> = new Set(['pending-approval', 'approved', 'expired'])
const MAX_PREPARED_FILES = 64
const MAX_PREPARED_FILE_BYTES = 65_536
const MAX_PREPARED_TOTAL_BYTES = 262_144
const MAX_COMMAND_OUTPUT_BYTES = 8_388_608
const COMMAND_TAIL_BYTES = 4_096

/**
 * T3 安全根插件绝不允许经成长执行体的隔离区窄口改写——即使产物只是待批
 * pending plan。命中即拒绝，不进入 worktree 流程。
 */
export const PROTECTED_PLUGIN_DENYLIST: ReadonlySet<string> = new Set([
  'assistant-policy', // 策略规则、授权寿命、急停根
  'credentials-keychain', // 凭据根
  'assistant-evaluation', // 评测答案根
  'assistant-verifier', // 验证/私钥评测根
  'assistant-deepseek-budget', // 预算上限根
  'assistant-super-relay-budget', // 预算上限根
  'assistant-skills', // sealed holdout 私钥与 holdout 数据集
  'assistant-isolation', // 隔离沙箱机制本身
  'assistant-web-owner', // owner 安全控制台
  'plugin-control-plane', // 审批/激活控制面本身（自举提权面）
])

export interface ScopedPluginFile {
  /** 相对于 plugins/<name>/ 的 POSIX 相对路径，不允许 .. 或绝对路径。 */
  path: string
  content: string
}

export interface IsolatedWorktree {
  worktree: string
  remove: () => Promise<void>
}

export function assertPluginModificationAllowed(name: string): void {
  if (PROTECTED_PLUGIN_DENYLIST.has(name)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', `plugin ${JSON.stringify(name)} is a protected safety root and cannot be modified by growth proposals`)
  }
}

export async function resolveLocalExecutable(command: 'git' | 'pnpm', environment: NodeJS.ProcessEnv): Promise<string> {
  const candidates = command === 'git' ? ['/usr/bin/git', '/bin/git'] : [join(dirname(process.execPath), 'pnpm'),
    ...(environment.PATH ?? '').split(delimiter).filter(isAbsolute).map(directory => join(directory, 'pnpm'))]
  const uid = process.getuid?.()
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate); const value = await lstat(canonical); const directory = await lstat(dirname(canonical))
      if (value.isFile() && !value.isSymbolicLink() && (value.mode & 0o111) !== 0 && (value.mode & 0o022) === 0
        && (uid === undefined || value.uid === 0 || value.uid === uid) && directory.isDirectory() && (directory.mode & 0o002) === 0) return canonical
    } catch { /* next candidate */ }
  }
  throw new ControlPlaneCliError('SOURCE_BOUNDARY', `registered local ${command} executable is unavailable`)
}

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000
const DEFAULT_COMMAND_OUTPUT_BYTES = 65_536

export interface RunLocalOptions {
  /** Capture stdout for the result (and bound it). When false, stdout is drained and discarded — exactly like the legacy localCommand, whose uncaptured output had no byte bound. */
  capture?: boolean
  maximumOutput?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export interface RunLocalResult {
  stdout: string
  stdoutBuffer: Buffer
  stderrTail: string
  durationMs: number
  logDigest: string
}

async function runLocalBounded(command: 'git' | 'pnpm', args: readonly string[], cwd: string,
  environment: NodeJS.ProcessEnv, options: RunLocalOptions = {}): Promise<RunLocalResult> {
  const executable = await resolveLocalExecutable(command, environment)
  const capture = options.capture ?? false
  const maximumOutput = options.maximumOutput ?? DEFAULT_COMMAND_OUTPUT_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  return new Promise((resolvePromise, reject) => {
    options.signal?.throwIfAborted()
    const child = spawn(executable, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    const stdout: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0; let stderrBytes = 0; let outputLimit = false; let timedOut = false
    child.stdout!.on('data', (chunk: Buffer) => {
      if (!capture) return // drain only: uncaptured output must never bound or kill (legacy localCommand semantics)
      stdoutBytes += chunk.length
      if (stdoutBytes > maximumOutput) { if (!outputLimit) { outputLimit = true; child.kill('SIGKILL') } }
      else stdout.push(chunk)
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      // Keep only a bounded sliding tail of stderr; it exists purely for the
      // diagnostic suffix and the content-free log digest.
      stderrBytes += chunk.length; stderrChunks.push(chunk)
      while (stderrChunks.length > 1 && stderrBytes - stderrChunks[0]!.length >= COMMAND_TAIL_BYTES) {
        stderrBytes -= stderrChunks[0]!.length; stderrChunks.shift()
      }
    })
    const started = Date.now()
    const cancel = (): void => { child.kill('SIGKILL') }
    const timer = setTimeout(() => { timedOut = true; cancel() }, timeoutMs)
    options.signal?.addEventListener('abort', cancel, { once: true })
    child.once('error', () => { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); reject(new ControlPlaneCliError('EXECUTOR_FAILED', `local ${command} could not start`)) })
    child.once('close', code => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', cancel)
      const durationMs = Date.now() - started
      const stdoutBuffer = Buffer.concat(stdout); const stdoutText = stdoutBuffer.toString('utf8')
      const stderrTail = Buffer.concat(stderrChunks).toString('utf8').slice(-COMMAND_TAIL_BYTES)
      const logDigest = createHash('sha256').update(stdoutText).update('\0').update(stderrTail).digest('hex')
      if (options.signal?.aborted) { reject(options.signal.reason); return }
      if (timedOut) {
        reject(new ControlPlaneCliError('EXECUTOR_TIMEOUT', `local ${command} ${JSON.stringify(args[0] ?? '')} exceeded its ${timeoutMs}ms deadline (log ${logDigest})`))
        return
      }
      if (outputLimit) {
        reject(new ControlPlaneCliError('EXECUTOR_OUTPUT_LIMIT', `local ${command} ${JSON.stringify(args[0] ?? '')} exceeded the ${maximumOutput}-byte output bound (log ${logDigest})`))
        return
      }
      if (code !== 0) {
        reject(new ControlPlaneCliError('EXECUTOR_FAILED',
          `local ${command} ${JSON.stringify(args[0] ?? '')} exited ${code} (log ${logDigest})${stderrTail === '' ? '' : `: ${stderrTail.trimEnd()}`}`))
        return
      }
      resolvePromise({ stdout: stdoutText, stdoutBuffer, stderrTail, durationMs, logDigest })
    })
  })
}

export async function runLocalBuffer(command: 'git' | 'pnpm', args: readonly string[], cwd: string,
  environment: NodeJS.ProcessEnv, options: RunLocalOptions = {}): Promise<Buffer> {
  return (await runLocalBounded(command, args, cwd, environment, { ...options, capture: true })).stdoutBuffer
}

export async function runLocalCommand(command: 'git' | 'pnpm', args: readonly string[], cwd: string,
  environment: NodeJS.ProcessEnv, options: RunLocalOptions = {}): Promise<string> {
  const result = await runLocalBounded(command, args, cwd, environment, options)
  return options.capture === true ? result.stdout : ''
}

export async function changedSourcePaths(worktree: string, baseCommit: string, environment: NodeJS.ProcessEnv): Promise<readonly string[]> {
  const tracked = await runLocalCommand('git', ['--literal-pathspecs', '-c', 'core.quotepath=false', 'diff', '--no-renames',
    '--name-only', '-z', baseCommit, '--'], worktree, environment, { capture: true, maximumOutput: MAX_COMMAND_OUTPUT_BYTES })
  const untracked = await runLocalCommand('git', ['--literal-pathspecs', '-c', 'core.quotepath=false', 'ls-files', '--others',
    '--exclude-standard', '-z'], worktree, environment, { capture: true, maximumOutput: MAX_COMMAND_OUTPUT_BYTES })
  return [...new Set(`${tracked}${untracked}`.split('\0').filter(Boolean))].sort()
}

export function sourcePathAllowed(path: string, name: string, mode: 'create' | 'modify' = 'modify'): boolean {
  const pluginRoot = `plugins/${name}`
  const withinPluginTree = path === pluginRoot || path.startsWith(`${pluginRoot}/`)
  return mode === 'create' ? (withinPluginTree || path === pluginCatalogScope) : withinPluginTree
}

export async function checkedSourceSnapshot(worktree: string, baseCommit: string, scopeInput: readonly string[],
  environment: NodeJS.ProcessEnv, preparedTree?: string): Promise<{ checkedTreeDigest: string; checkedPatchDigest: string }> {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-plugin-control-index-'))
  try {
    const scope = [...new Set(scopeInput.map(value => value.normalize('NFC').trim()))].sort()
    if (scope.length === 0 || scope.some(value => value === '')) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'checked source scope is invalid')
    const snapshotEnvironment = { ...environment, GIT_INDEX_FILE: join(temporary, 'index') }
    await runLocalCommand('git', ['read-tree', preparedTree ?? baseCommit], worktree, snapshotEnvironment)
    if (preparedTree === undefined) await runLocalCommand('git', ['--literal-pathspecs', 'add', '--all', '--', ...scope], worktree, snapshotEnvironment)
    const tree = await runLocalCommand('git', ['--literal-pathspecs', '-c', 'core.quotepath=false', 'ls-files', '--stage', '-z',
      '--', ...scope], worktree, snapshotEnvironment, { capture: true, maximumOutput: MAX_COMMAND_OUTPUT_BYTES })
    const patch = await runLocalCommand('git', ['--literal-pathspecs', '-c', 'core.quotepath=false', 'diff', '--cached', '--binary',
      '--full-index', '--no-color', baseCommit, '--', ...scope], worktree, snapshotEnvironment,
      { capture: true, maximumOutput: MAX_COMMAND_OUTPUT_BYTES })
    const binding = `${baseCommit}\0${JSON.stringify(scope)}\0`
    return {
      checkedTreeDigest: createHash('sha256').update('dsh-source-tree-v2\0').update(binding).update(tree).digest('hex'),
      checkedPatchDigest: createHash('sha256').update('dsh-source-patch-v2\0').update(binding).update(patch).digest('hex'),
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

async function assertOwnerDirectory(path: string): Promise<void> {
  const metadata = await lstat(path)
  const uid = process.getuid?.()
  if (metadata.isSymbolicLink() || !metadata.isDirectory()
    || (uid !== undefined && metadata.uid !== 0 && metadata.uid !== uid)
    || (metadata.mode & 0o022) !== 0) {
    throw new ControlPlaneCliError('FILESYSTEM_STATE', `source state directory ${JSON.stringify(path)} is not an owner-owned non-symlink directory`)
  }
}

/**
 * Create a throwaway linked git worktree under the control-plane state root,
 * detached at exactly baseCommit. Removal prunes the worktree registration and
 * falls back to deleting the directory.
 */
export async function createIsolatedWorktree(input: {
  stateRoot: string; repository: string; baseCommit: string; environment: NodeJS.ProcessEnv; worktreeName?: string
}): Promise<IsolatedWorktree> {
  if (!/^[a-f0-9]{40}$/u.test(input.baseCommit)) throw new ControlPlaneCliError('INVALID_ARGUMENT', 'base commit must be a 40-hex commit id')
  await mkdir(input.stateRoot, { recursive: true, mode: 0o700 })
  await assertOwnerDirectory(input.stateRoot)
  const repository = await realpath(input.repository)
  if (resolve(repository) !== repository) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'repository path must be canonical')
  const verified = (await runLocalCommand('git', ['rev-parse', '--verify', `${input.baseCommit}^{commit}`], repository,
    input.environment, { capture: true })).trim()
  if (verified !== input.baseCommit) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base commit did not resolve to itself')
  if (input.worktreeName !== undefined && !/^worktree-job-[a-f0-9]{64}$/u.test(input.worktreeName)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'invalid durable worktree name')
  const worktree = input.worktreeName === undefined
    ? await mkdtemp(join(input.stateRoot, 'worktree-')) : join(input.stateRoot, input.worktreeName)
  // Exclusive creation: a crash residue never becomes a fresh build workspace.
  if (input.worktreeName !== undefined) await mkdir(worktree, { mode: 0o700 })
  try {
    await runLocalCommand('git', ['worktree', 'add', '--detach', worktree, input.baseCommit], repository, input.environment)
  } catch (error) {
    if (input.worktreeName === undefined) await rm(worktree, { recursive: true, force: true })
    // Durable acquisition failures retain ambiguous residue for explicit
    // reconciliation; its persisted job remains unknown and occupies capacity.
    throw error
  }
  let removed = false
  const remove = async (): Promise<void> => {
    if (removed) return
    if (input.worktreeName !== undefined) {
      await removeSourceJobWorktree({ ...input, repository, worktree })
      removed = true
      return
    }
    removed = true
    try {
      await runLocalCommand('git', ['worktree', 'remove', '--force', worktree], repository, input.environment)
      await runLocalCommand('git', ['worktree', 'prune'], repository, input.environment).catch(() => undefined)
    } catch {
      await rm(worktree, { recursive: true, force: true })
      await runLocalCommand('git', ['worktree', 'prune'], repository, input.environment).catch(() => undefined)
    }
  }
  return { worktree: await realpath(worktree), remove }
}

/** Host-only reconciliation of the exact durable resource; never rebuilds it. */
export async function removeSourceJobWorktree(input: {
  stateRoot: string; repository: string; worktree: string; baseCommit: string; environment: NodeJS.ProcessEnv
}): Promise<void> {
  if (dirname(input.worktree) !== resolve(input.stateRoot)
    || !/^worktree-job-[a-f0-9]{64}$/u.test(input.worktree.slice(input.stateRoot.length + 1))) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'durable worktree is outside its private root')
  }
  await mkdir(input.stateRoot, { recursive: true, mode: 0o700 })
  await assertOwnerDirectory(input.stateRoot)
  const metadata = await lstat(input.worktree).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (metadata !== undefined) {
    await assertOwnerDirectory(input.worktree)
    const listing = await runLocalCommand('git', ['worktree', 'list', '--porcelain', '-z'], input.repository, input.environment, { capture: true })
    const registration = listing.split('\0\0').find(entry => entry.split('\0')[0] === `worktree ${input.worktree}`)
    if (registration === undefined) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'durable worktree registration is unproven; operator inspection required')
    } else {
      if (!registration.split('\0').includes(`HEAD ${input.baseCommit}`)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'durable worktree base identity changed')
      const common = async (cwd: string): Promise<string> => (await runLocalCommand('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd, input.environment, { capture: true })).trim()
      const top = (await runLocalCommand('git', ['rev-parse', '--show-toplevel'], input.worktree, input.environment, { capture: true })).trim()
      if (top !== input.worktree || await common(input.worktree) !== await common(input.repository)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'durable worktree repository identity changed')
      await runLocalCommand('git', ['worktree', 'remove', '--force', input.worktree], input.repository, input.environment)
    }
  }
  await runLocalCommand('git', ['worktree', 'prune'], input.repository, input.environment)
  const listing = await runLocalCommand('git', ['worktree', 'list', '--porcelain', '-z'], input.repository, input.environment, { capture: true })
  const remains = await lstat(input.worktree).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  if (remains || listing.split('\0').includes(`worktree ${input.worktree}`)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'durable worktree cleanup is unproven')
}

/**
 * Write a bounded set of plugin files through O_NOFOLLOW handles. Every path is
 * constrained to plugins/<name>/; the plugin root must already exist at the
 * base commit (modify never creates a plugin root, and never touches
 * plugins/README.md).
 */
export async function writeScopedPluginFiles(input: {
  worktree: string; name: string; files: readonly ScopedPluginFile[]
}): Promise<void> {
  const { worktree, name, files } = input
  validateScopedPluginFiles(files)
  await writeValidatedPluginFiles(worktree, name, files)
}

/** Validate bytes and paths before persisting a durable source job. */
export function validateScopedPluginFiles(files: readonly ScopedPluginFile[]): void {
  if (!Array.isArray(files)) throw new ControlPlaneCliError('INVALID_ARGUMENT', 'prepared files must be an array')
  if (files.length < 1 || files.length > MAX_PREPARED_FILES) {
    throw new ControlPlaneCliError('INVALID_ARGUMENT', `a prepared modification must carry 1..${MAX_PREPARED_FILES} files`)
  }
  const seen = new Set<string>()
  let totalBytes = 0
  for (const file of files) {
    if (file === null || typeof file !== 'object' || typeof file.path !== 'string' || typeof file.content !== 'string') throw new ControlPlaneCliError('INVALID_ARGUMENT', 'prepared file must contain text path and content')
    const normalized: string = file.path.normalize('NFC')
    if (normalized === '' || isAbsolute(normalized) || normalized.includes('\\')
      || normalized.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', `prepared file path escapes the plugin tree: ${JSON.stringify(file.path)}`)
    }
    if (normalized.split('/').some(segment => segment === '.gitattributes' || segment === '.gitmodules' || segment === '.git')) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', `prepared file changes Git archive control data: ${JSON.stringify(file.path)}`)
    }
    if (seen.has(normalized)) throw new ControlPlaneCliError('INVALID_ARGUMENT', `duplicate prepared file path: ${JSON.stringify(normalized)}`)
    seen.add(normalized)
    const bytes = Buffer.byteLength(file.content, 'utf8')
    if (bytes > MAX_PREPARED_FILE_BYTES) throw new ControlPlaneCliError('INVALID_ARGUMENT', `prepared file ${JSON.stringify(normalized)} exceeds the ${MAX_PREPARED_FILE_BYTES}-byte bound`)
    totalBytes += bytes
    if (totalBytes > MAX_PREPARED_TOTAL_BYTES) throw new ControlPlaneCliError('INVALID_ARGUMENT', `prepared files exceed the ${MAX_PREPARED_TOTAL_BYTES}-byte total bound`)
  }
}

async function writeValidatedPluginFiles(worktree: string, name: string, files: readonly ScopedPluginFile[]): Promise<void> {
  const pluginRoot = resolve(worktree, 'plugins', name)
  const rootMetadata = await lstat(pluginRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (rootMetadata === undefined || rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', `plugin ${JSON.stringify(name)} root must already exist in the base commit; prepared modifications cannot create a plugin`)
  }
  for (const file of files) {
    const normalized = file.path.normalize('NFC')
    const segments = normalized.split('/')
    // Every parent segment must be an existing non-symlink directory at the
    // base commit; modify never creates directories.
    let parent = pluginRoot
    for (const segment of segments.slice(0, -1)) {
      parent = join(parent, segment)
      const metadata = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (metadata === undefined || metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', `prepared file parent directory must already exist and must not be a symlink: ${JSON.stringify(normalized)}`)
      }
    }
    const target = join(parent, segments[segments.length - 1]!)
    const outside = relative(pluginRoot, target)
    if (outside === '' || outside.startsWith('..') || isAbsolute(outside)) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', `prepared file path escapes the plugin tree: ${JSON.stringify(file.path)}`)
    }
    const targetMetadata = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (targetMetadata !== undefined && targetMetadata.isSymbolicLink()) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', `symlinked source path is forbidden: ${JSON.stringify(normalized)}`)
    }
    let handle
    try {
      handle = await open(target,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o644)
    } catch (error) {
      // O_NOFOLLOW reports a trailing symlink as ELOOP.
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', `symlinked source path is forbidden: ${JSON.stringify(normalized)}`)
      }
      throw error
    }
    try { await handle.truncate(0); await handle.writeFile(file.content, 'utf8') } finally { await handle.close() }
  }
}

/**
 * A prepared modify worktree is garbage only while its plan is still waiting on
 * the owner (pending/approved) and the plan's TTL has elapsed. Plans that
 * reached ready-for-human-review or a release phase are retained for the
 * owner's release workflow.
 */
export function preparedWorktreeIsGarbage(plan: { status: string; expiresAt: number }, now: number): boolean {
  return GC_ELIGIBLE_SOURCE_STATUSES.has(plan.status) && plan.expiresAt < now
}

/** Parse `git worktree list --porcelain` into canonical linked-worktree paths. */
export async function linkedWorktrees(repository: string, environment: NodeJS.ProcessEnv): Promise<readonly string[]> {
  const porcelain = await runLocalCommand('git', ['worktree', 'list', '--porcelain'], repository,
    environment, { capture: true, maximumOutput: MAX_COMMAND_OUTPUT_BYTES })
  return porcelain.split('\n').filter(line => line.startsWith('worktree ')).map(line => resolve(line.slice('worktree '.length)))
}

/**
 * Remove a prepared worktree registered against `repository`. Idempotent: an
 * already-unregistered or missing directory resolves successfully after
 * pruning. The caller is responsible for proving the path is still inside the
 * control-plane state root.
 */
export async function pruneRegisteredWorktree(input: {
  repository: string; worktree: string; environment: NodeJS.ProcessEnv
}): Promise<void> {
  try {
    await runLocalCommand('git', ['worktree', 'remove', '--force', input.worktree], input.repository, input.environment)
  } catch {
    await rm(input.worktree, { recursive: true, force: true })
  }
  await runLocalCommand('git', ['worktree', 'prune'], input.repository, input.environment).catch(() => undefined)
}

/**
 * Remove prepared modify worktrees whose plans expired while still waiting on
 * the owner. Every removed path must (1) belong to a modify plan, (2) be a
 * descendant of the control-plane state root and (3) still be a linked
 * worktree of the plan's repository; anything outside those proofs is left
 * untouched. Idempotent. Shared by the service and the owner CLI.
 */
export async function gcPreparedModifyWorktrees(input: {
  store: ControlPlaneStore
  statePath: string
  environment: NodeJS.ProcessEnv
  now: number
}): Promise<{ removed: readonly string[] }> {
  const stateRoot = resolve(join(input.statePath, 'source-worktrees'))
  const removed: string[] = []
  for (const plan of input.store.listModifySourcePlans() as PluginSourcePlan[]) {
    if (!preparedWorktreeIsGarbage(plan, input.now)) continue
    const worktree = resolve(plan.worktree)
    const inside = relative(stateRoot, worktree)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) continue
    const linked = await linkedWorktrees(plan.repository, input.environment).catch((): readonly string[] => [])
    if (!linked.includes(worktree)) continue
    input.store.expirePreparedSourcePlan({ planId: plan.id, expectedRevision: plan.revision, now: input.now })
    await pruneRegisteredWorktree({ repository: plan.repository, worktree, environment: input.environment })
    removed.push(worktree)
  }
  return Object.freeze({ removed: Object.freeze(removed) })
}
