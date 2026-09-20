import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Immutable local inputs for the independent source-review reader. */
export type SourceReviewGitConfig = {
  repository: string
  git: { path: string; sha256: string }
  maxChangedFiles: number
  maxInputBytes: number
}

/** The control-plane snapshot which this reader must reproduce. */
export type SourceReviewGitRequest = {
  name: string
  baseCommit: string
  headCommit: string
  prId: string
  scope: readonly string[]
  checkedTreeDigest: string
  checkedPatchDigest: string
}

const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const PLUGIN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const PR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const MAX_FENCE_OUTPUT = 8_192

function fail(message: string): never { throw new Error(`assistant-verifier source review: ${message}`) }

function canonicalRegularFile(path: string, label: string, executable = false): string {
  if (!isAbsolute(path) || resolve(path) !== path) fail(`${label} path is not canonical`)
  let canonical: string; let value: ReturnType<typeof lstatSync>; let parent: ReturnType<typeof lstatSync>
  try { canonical = realpathSync(path); value = lstatSync(canonical); parent = lstatSync(dirname(canonical)) } catch { fail(`${label} is unavailable`) }
  const uid = process.getuid?.()
  if (canonical !== path || value.isSymbolicLink() || !value.isFile() || parent.isSymbolicLink() || !parent.isDirectory()
    || (value.mode & 0o022) !== 0 || (parent.mode & 0o002) !== 0 || (executable && (value.mode & 0o111) === 0)
    || (uid !== undefined && value.uid !== 0 && value.uid !== uid)) fail(`${label} is not a trusted regular file`)
  return canonical
}

function assertBareRepository(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) fail('repository path is not canonical')
  let canonical: string; let metadata: ReturnType<typeof lstatSync>
  try { canonical = realpathSync(path); metadata = lstatSync(canonical) } catch { fail('repository is unavailable') }
  const uid = process.getuid?.()
  if (canonical !== path || metadata.isSymbolicLink() || !metadata.isDirectory() || (metadata.mode & 0o022) !== 0
    || (uid !== undefined && metadata.uid !== 0 && metadata.uid !== uid)) fail('repository is not an owner-controlled directory')
  // Read this single, local bare-repository marker directly.  Do not ask git to
  // interpret a candidate-controlled configuration merely to identify the repo.
  const config = canonicalRegularFile(join(canonical, 'config'), 'bare repository config')
  const text = readFileSync(config, 'utf8')
  if (!/^\s*\[core\]\s*(?:\r?\n[\s\S]*?)?^\s*bare\s*=\s*true\s*$/imu.test(text)) fail('repository is not configured as bare')
  for (const entry of ['HEAD', 'objects', 'refs']) {
    try { if (lstatSync(join(canonical, entry)).isSymbolicLink()) fail('repository contains a symbolic top-level entry') } catch { fail('repository is incomplete') }
  }
  return canonical
}

function assertRequest(request: SourceReviewGitRequest): void {
  if (!request || typeof request !== 'object' || Object.keys(request).length !== 7
    || typeof request.name !== 'string' || !PLUGIN.test(request.name)
    || typeof request.baseCommit !== 'string' || !COMMIT.test(request.baseCommit)
    || typeof request.headCommit !== 'string' || !COMMIT.test(request.headCommit)
    || typeof request.prId !== 'string' || !PR_ID.test(request.prId)
    || !Array.isArray(request.scope) || request.scope.length !== 1 || request.scope[0] !== `plugins/${request.name}`
    || typeof request.checkedTreeDigest !== 'string' || !SHA256.test(request.checkedTreeDigest)
    || typeof request.checkedPatchDigest !== 'string' || !SHA256.test(request.checkedPatchDigest)) fail('request is invalid')
}

function assertConfig(config: SourceReviewGitConfig, repository = true): { git: string; repo?: string } {
  if (!config || typeof config !== 'object' || Object.keys(config).length !== 4 || typeof config.repository !== 'string'
    || !config.git || typeof config.git !== 'object' || Object.keys(config.git).length !== 2 || typeof config.git.path !== 'string'
    || typeof config.git.sha256 !== 'string' || !SHA256.test(config.git.sha256)
    || !Number.isSafeInteger(config.maxChangedFiles) || config.maxChangedFiles < 1 || config.maxChangedFiles > 10_000
    || !Number.isSafeInteger(config.maxInputBytes) || config.maxInputBytes < 1 || config.maxInputBytes > 16 * 1024 * 1024) fail('config is invalid')
  const git = canonicalRegularFile(config.git.path, 'git executable', true)
  const digest = createHash('sha256').update(readFileSync(git)).digest('hex')
  if (digest !== config.git.sha256) fail('git executable identity changed')
  return repository ? { git, repo: assertBareRepository(config.repository) } : { git }
}

function safeEnvironment(git: string, index?: string): NodeJS.ProcessEnv {
  return { PATH: dirname(git), HOME: '/', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_EDITOR: 'true',
    GIT_ALLOW_PROTOCOL: '', GIT_OPTIONAL_LOCKS: '0', ...(index ? { GIT_INDEX_FILE: index } : {}) }
}

function gitArgs(repo: string, args: readonly string[]): string[] {
  return ['--no-optional-locks', `--git-dir=${repo}`, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c',
    'core.useBuiltinFSMonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.quotepath=false', ...args]
}

async function run(git: string, repo: string, args: readonly string[], maximum: number, signal: AbortSignal | undefined, index?: string): Promise<Buffer> {
  signal?.throwIfAborted()
  return new Promise((resolvePromise, reject) => {
    const child = spawn(git, gitArgs(repo, args), { cwd: repo, env: safeEnvironment(git, index), shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []; let bytes = 0; let exceeded = false
    const cancel = () => { child.kill('SIGKILL') }
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maximum) { exceeded = true; cancel() } else chunks.push(chunk)
    })
    // Always drain diagnostics so cancellation cannot leave the child blocked.
    child.stderr!.resume()
    signal?.addEventListener('abort', cancel, { once: true })
    child.once('error', () => { signal?.removeEventListener('abort', cancel); reject(new Error('assistant-verifier source review: git could not start')) })
    child.once('close', code => {
      signal?.removeEventListener('abort', cancel)
      if (signal?.aborted) { reject(signal.reason); return }
      if (exceeded) { reject(new Error('assistant-verifier source review: git input exceeds configured byte limit')); return }
      if (code !== 0) { reject(new Error('assistant-verifier source review: git command failed')); return }
      resolvePromise(Buffer.concat(chunks))
    })
  })
}

async function exactHead(git: string, repo: string, request: SourceReviewGitRequest, signal?: AbortSignal): Promise<void> {
  const ref = `refs/dsh-release/pulls/${request.prId}/head`
  const actual = (await run(git, repo, ['rev-parse', '--verify', `${ref}^{commit}`], MAX_FENCE_OUTPUT, signal)).toString('ascii').trim()
  if (actual !== request.headCommit) fail('release PR head changed')
  const parents = (await run(git, repo, ['show', '-s', '--format=%P', request.headCommit], MAX_FENCE_OUTPUT, signal)).toString('ascii').trim().split(/\s+/u).filter(Boolean)
  if (parents.length !== 1 || parents[0] !== request.baseCommit) fail('release PR parent changed')
}

function paths(output: Buffer): string[] {
  const result: string[] = []
  let start = 0
  for (let index = 0; index < output.length; index++) if (output[index] === 0) {
    if (index === start) fail('git returned an empty path')
    result.push(output.subarray(start, index).toString('utf8')); start = index + 1
  }
  if (start !== output.length) fail('git returned a malformed NUL path list')
  return result
}

function assertSafeIndexEntries(tree: Buffer): void {
  for (const record of paths(tree)) {
    const match = /^(100644|100755|120000|160000) [0-9a-f]{40} [0-3]\t/u.exec(record)
    if (!match) fail('git returned an invalid index entry')
    if (match[1] === '120000' || match[1] === '160000') fail('source review rejects symbolic links and gitlinks')
  }
}

function assertSafePatch(patch: Buffer): void {
  // A deleted link/gitlink is absent from the head index, so inspect its binary
  // diff metadata too. Git emits these mode markers before any content body.
  if (/(?:^|\n)(?:new|deleted) file mode (?:120000|160000)\n|(?:^|\n)Subproject commit /u.test(patch.toString('utf8'))) {
    fail('source review rejects symbolic links and gitlinks')
  }
}

/**
 * Recreates the control-plane snapshot using only objects reachable from the
 * fixed release PR ref.  Candidate source is never checked out or executed.
 */
export async function inspectSourceReviewGit(config: SourceReviewGitConfig, request: SourceReviewGitRequest,
  signal?: AbortSignal): Promise<{ patch: string; changedPaths: readonly string[]; digest: string }> {
  assertRequest(request); const { git, repo } = assertConfig(config); const repository = repo!
  // Do not retain mutable caller objects across asynchronous process calls.
  const pinned = Object.freeze({ ...request, scope: Object.freeze([...request.scope]) })
  await exactHead(git, repository, pinned, signal)
  const allChanged = paths(await run(git, repository, ['--literal-pathspecs', 'diff', '--no-renames', '--name-only', '-z',
    pinned.baseCommit, pinned.headCommit, '--'], config.maxInputBytes, signal))
  if (allChanged.length > config.maxChangedFiles) fail('changed file count exceeds configured limit')
  const scope = [...pinned.scope].sort()
  if (allChanged.some(path => path !== scope[0] && !path.startsWith(`${scope[0]}/`))) fail('release PR changes files outside the approved scope')
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-source-review-index-'))
  try {
    const index = join(temporary, 'index')
    await run(git, repository, ['read-tree', pinned.headCommit], config.maxInputBytes, signal, index)
    const tree = await run(git, repository, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...scope], config.maxInputBytes, signal, index)
    assertSafeIndexEntries(tree)
    const patch = await run(git, repository, ['--literal-pathspecs', 'diff', '--cached', '--binary', '--full-index', '--no-color',
      '--no-ext-diff', '--no-textconv', pinned.baseCommit, '--', ...scope], config.maxInputBytes, signal, index)
    assertSafePatch(patch)
    const binding = `${pinned.baseCommit}\0${JSON.stringify(scope)}\0`
    const treeDigest = createHash('sha256').update('dsh-source-tree-v2\0').update(binding).update(tree).digest('hex')
    const digest = createHash('sha256').update('dsh-source-patch-v2\0').update(binding).update(patch).digest('hex')
    if (treeDigest !== pinned.checkedTreeDigest || digest !== pinned.checkedPatchDigest) fail('control-plane source snapshot changed')
    // A short final fence deliberately repeats only the executable and the
    // immutable PR head/parent binding after the expensive read has completed.
    assertSourceReviewHeadPinned(git, repository, pinned)
    return { patch: patch.toString('utf8'), changedPaths: Object.freeze([...allChanged].sort()), digest }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

function assertSourceReviewHeadPinned(git: string, repository: string, request: SourceReviewGitRequest): void {
  const ref = `refs/dsh-release/pulls/${request.prId}/head`
  const execute = (args: readonly string[]): string => {
    const value = spawnSync(git, gitArgs(repository, args), { cwd: repository, env: safeEnvironment(git), shell: false, encoding: 'ascii', timeout: 5_000, maxBuffer: MAX_FENCE_OUTPUT })
    if (value.error || value.status !== 0 || value.stdout.length > MAX_FENCE_OUTPUT) fail('git final fence failed')
    return value.stdout.trim()
  }
  if (execute(['rev-parse', '--verify', `${ref}^{commit}`]) !== request.headCommit) fail('release PR head changed')
  const parents = execute(['show', '-s', '--format=%P', request.headCommit]).split(/\s+/u).filter(Boolean)
  if (parents.length !== 1 || parents[0] !== request.baseCommit) fail('release PR parent changed')
}

/** Synchronous, bounded final fence for a completed review. */
export function assertSourceReviewHead(config: SourceReviewGitConfig, request: SourceReviewGitRequest): void {
  assertRequest(request); const { git } = assertConfig(config, false)
  if (!isAbsolute(config.repository) || resolve(config.repository) !== config.repository) fail('repository path is not canonical')
  assertSourceReviewHeadPinned(git, config.repository, request)
}
