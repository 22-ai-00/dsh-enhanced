import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ControlPlaneCliError } from './errors.js'
import { checkedSourceSnapshot, runLocalCommand } from './source-workspace.js'
import type { SourcePreparedEvidence } from './types.js'

export interface SourceBuildConfig {
  /** Canonical owner-controlled docker client. */
  dockerPath: string
  /** Image pinned by manifest reference or a local immutable image content ID. */
  image: string
  timeoutMs: number
  memoryMiB: number
  cpus: number
  pidsLimit: number
  workspaceMiB: number
  outputBytes: number
  /** Owner-only opt-in for the larger, full-repository check budget. */
  profile?: 'standard' | 'repository'
  /** Writable /tmp tmpfs size. Defaults to 32 MiB for standard, 2048 MiB for repository. */
  temporaryMiB?: number
  /** Explicit owner opt-in for nested unprivileged sandboxes. Relaxes Docker's
   * system-path masks, hides /sys, and requires the pinned seccomp/runtime. */
  repositorySandbox?: { seccompPath: string }
}

export interface SourceBuildResult {
  treeDigest: string
  patchDigest: string
  checkedAt: number
  evidence: SourcePreparedEvidence
}

const imageDigest = /^(?:[a-z0-9][a-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/u
const marker = /^DSH_PREPARED_PACK\t([^\t\n]+)\t([0-9]+)\t([a-f0-9]{64})\t([^\t\n]+)\t([^\t\n]+)$/mu
const repositorySeccompSha256 = 'b1e4b5b709578785bd2aff4a3a344301997571ad0e8ae5747aec176571ddc342'

/** Exact in-container command recorded in prepared source evidence. */
export const PREPARED_SOURCE_BUILD_SCRIPT = 'set -eu; checked() { phase="$1"; shift; if "$@" >"/tmp/$phase.log" 2>&1; then return 0; else code=$?; printf "source build phase failed: %s\\n" "$phase" >&2; tail -c 8192 "/tmp/$phase.log" >&2; return "$code"; fi; }; umask 077; mkdir -p /workspace; tar -x -C /workspace; cd /workspace; checked install pnpm install --offline --frozen-lockfile --ignore-scripts; checked check pnpm check; mkdir -p /workspace/.dsh-pack; cd "$PLUGIN_ROOT"; checked pack pnpm pack --pack-destination /workspace/.dsh-pack; set -- /workspace/.dsh-pack/*.tgz; test "$#" = 1; pack="$1"; printf "DSH_PREPARED_PACK\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "${pack##*/}" "$(wc -c < "$pack" | tr -d " ")" "$(sha256sum "$pack" | cut -d " " -f1)" "$(node --version)" "$(pnpm --version)"'

interface SourceBuildLimits {
  profile: 'standard' | 'repository'
  temporaryMiB: number
}

function sourceBuildLimits(config: SourceBuildConfig): SourceBuildLimits {
  const profile = config.profile ?? 'standard'
  return { profile, temporaryMiB: config.temporaryMiB ?? (profile === 'repository' ? 2_048 : 32) }
}

export function validateSourceBuildConfig(config: SourceBuildConfig): void {
  if (config === null || typeof config !== 'object' || Array.isArray(config) || (config.profile !== undefined && config.profile !== 'standard' && config.profile !== 'repository')
    || (config.temporaryMiB !== undefined && !Number.isSafeInteger(config.temporaryMiB))
    || (config.repositorySandbox !== undefined && (config.profile !== 'repository' || typeof config.repositorySandbox !== 'object' || config.repositorySandbox === null
      || Array.isArray(config.repositorySandbox) || Object.getPrototypeOf(config.repositorySandbox) !== Object.prototype
      || Object.keys(config.repositorySandbox).length !== 1 || Object.keys(config.repositorySandbox)[0] !== 'seccompPath'
      || typeof config.repositorySandbox.seccompPath !== 'string' || !config.repositorySandbox.seccompPath.startsWith('/') || config.repositorySandbox.seccompPath.includes('\0')))
    || typeof config.image !== 'string' || config.image.length > 256 || !imageDigest.test(config.image) || typeof config.dockerPath !== 'string' || !config.dockerPath.startsWith('/') || config.dockerPath.includes('\0')
    || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 60_000
    || !Number.isSafeInteger(config.memoryMiB) || config.memoryMiB < 128
    || !Number.isSafeInteger(config.pidsLimit) || config.pidsLimit < 16
    || !Number.isFinite(config.cpus) || config.cpus < 0.25
    || !Number.isSafeInteger(config.workspaceMiB) || config.workspaceMiB < 64
    || !Number.isSafeInteger(config.outputBytes) || config.outputBytes < 4096 || config.outputBytes > 1_048_576) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source build configuration is invalid')
  }
  const limits = sourceBuildLimits(config)
  const repository = limits.profile === 'repository'
  if (config.timeoutMs > (repository ? 1_800_000 : 240_000)
    || config.memoryMiB > (repository ? 16_384 : 4_096)
    || config.pidsLimit > (repository ? 1_024 : 512)
    || config.cpus > (repository ? 16 : 4)
    || config.workspaceMiB > (repository ? 8_192 : 2_048)
    || limits.temporaryMiB < 32 || limits.temporaryMiB > (repository ? 4_096 : 32)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source build configuration is invalid')
  }
}

async function snapshotRepositorySeccomp(config: SourceBuildConfig, temporary: string): Promise<{ path: string; digest: string } | undefined> {
  const sandbox = config.repositorySandbox
  if (sandbox === undefined) return undefined
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'repository seccomp requires linux x64')
  const canonical = await realpath(sandbox.seccompPath)
  if (canonical !== resolve(sandbox.seccompPath)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'repository seccomp profile must be canonical')
  const before = await lstat(canonical); const parent = await lstat(dirname(canonical)); const uid = process.getuid?.()
  if (!before.isFile() || before.isSymbolicLink() || before.size > 65_536 || (before.mode & 0o022) !== 0
    || !parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0
    || (uid !== undefined && before.uid !== 0 && before.uid !== uid)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'repository seccomp profile is not an owner-safe bounded regular file')
  }
  const bytes = await readFile(canonical)
  const after = await lstat(canonical)
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'repository seccomp profile changed while being read')
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== repositorySeccompSha256) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'repository seccomp profile digest is not approved')
  const path = join(temporary, 'repository-seccomp.json')
  await writeFile(path, bytes, { mode: 0o600 }); await chmod(path, 0o600)
  return { path, digest }
}

async function verifiedDockerPath(path: string): Promise<string> {
  const canonical = await realpath(path)
  const executable = await lstat(canonical); const parent = await lstat(dirname(canonical)); const uid = process.getuid?.()
  if (resolve(path) !== canonical || !executable.isFile() || executable.isSymbolicLink() || (executable.mode & 0o111) === 0
    || (executable.mode & 0o022) !== 0 || !parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o002) !== 0
    || (uid !== undefined && executable.uid !== 0 && executable.uid !== uid)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source build docker client is not a canonical owner-safe executable')
  }
  return canonical
}

async function sourceTree(worktree: string, baseCommit: string, scope: readonly string[], environment: NodeJS.ProcessEnv): Promise<{ tree: string; temporary: string; cleanup: () => Promise<void> }> {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-source-build-index-'))
  try {
    const env = { ...environment, GIT_INDEX_FILE: join(temporary, 'index') }
    await runLocalCommand('git', ['read-tree', baseCommit], worktree, env)
    await runLocalCommand('git', ['--literal-pathspecs', 'add', '--all', '--', ...scope], worktree, env)
    const tree = (await runLocalCommand('git', ['write-tree'], worktree, env, { capture: true })).trim()
    if (!/^[a-f0-9]{40}$/u.test(tree)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'temporary source tree is invalid')
    return { tree, temporary, cleanup: async () => { await rm(temporary, { recursive: true, force: true }) } }
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error }
}

/**
 * Archive an exact temporary-index tree into a disposable, mount-free Docker
 * container. No repository, state directory, socket, credential, environment
 * value, or Host path crosses the boundary: the sole input is tar on stdin.
 */
export async function runDockerPreparedChecks(input: {
  config: SourceBuildConfig
  worktree: string
  baseCommit: string
  name: string
  scope: readonly string[]
  environment: NodeJS.ProcessEnv
  signal: AbortSignal
  assertCurrent: () => Promise<void>
  preparedAt: number
  /** Frozen before resource acquisition by the durable Host job. */
  sourceJob?: { id: string; containerName: string }
}): Promise<SourceBuildResult> {
  if (input.sourceJob !== undefined && (!/^source-job-[a-f0-9]{64}$/u.test(input.sourceJob.id)
    || input.sourceJob.containerName !== `dsh-${input.sourceJob.id}`)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'invalid durable container identity')
  validateSourceBuildConfig(input.config); const limits = sourceBuildLimits(input.config); const dockerPath = await verifiedDockerPath(input.config.dockerPath); await input.assertCurrent()
  if (input.config.repositorySandbox !== undefined) {
    const version = await dockerControl(dockerPath, ['version', '--format', '{{.Server.Version}}/{{.Server.Os}}/{{.Server.Arch}}'], input.signal)
    if (version.code !== 0 || version.stdout.trim() !== '29.4.1/linux/amd64') throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'repository seccomp requires approved Docker runtime 29.4.1/linux/amd64')
    await input.assertCurrent()
  }
  const snapshot = await sourceTree(input.worktree, input.baseCommit, input.scope, input.environment)
  let before: Awaited<ReturnType<typeof checkedSourceSnapshot>>
  let packageVersion: string
  let seccomp: { path: string; digest: string } | undefined
  try {
    seccomp = await snapshotRepositorySeccomp(input.config, snapshot.temporary)
    before = await checkedSourceSnapshot(input.worktree, input.baseCommit, input.scope, input.environment, snapshot.tree)
    const packageJson = await runLocalCommand('git', ['show', `${snapshot.tree}:plugins/${input.name}/package.json`],
      input.worktree, input.environment, { capture: true, maximumOutput: 65_536 })
    const value: unknown = (JSON.parse(packageJson) as { version?: unknown })?.version
    if (typeof value !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value)) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source package version is invalid')
    }
    packageVersion = value
    await input.assertCurrent()
    input.signal.throwIfAborted()
  } catch (error) { await snapshot.cleanup(); throw error }
  const container = input.sourceJob?.containerName ?? `dsh-source-prepare-${randomUUID()}`
  if (input.sourceJob !== undefined) {
    try {
      const existing = await dockerControl(dockerPath, ['container', 'ls', '--all', '--quiet', '--filter', `name=^/${container}$`], input.signal)
      if (existing.code !== 0 || existing.stdout.trim() !== '') throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'durable source container already exists or cannot be inspected')
    } catch (error) { await snapshot.cleanup(); throw error }
  }
  const script = PREPARED_SOURCE_BUILD_SCRIPT
  const args = ['run', '-i', '--pull', 'never', '--name', container, '--label', `dsh.source.tree=${snapshot.tree}`, ...(input.sourceJob === undefined ? [] : ['--label', `dsh.source.job=${input.sourceJob.id}`]), ...(seccomp === undefined ? [] : ['--label', `dsh.source.seccomp.sha256=${seccomp.digest}`]), '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--pids-limit', String(input.config.pidsLimit),
    '--memory', `${input.config.memoryMiB}m`, '--memory-swap', `${input.config.memoryMiB}m`, '--cpus', String(input.config.cpus),
    '--tmpfs', `/workspace:rw,nosuid,nodev,mode=1777,size=${input.config.workspaceMiB}m${limits.profile === 'repository' ? ',exec' : ''}`, '--tmpfs', `/tmp:rw,nosuid,nodev,mode=1777,size=${limits.temporaryMiB}m${limits.profile === 'repository' ? ',exec' : ''}`,
    '--workdir', '/workspace', '--env', `PLUGIN_ROOT=plugins/${input.name}`, '--env', 'HOME=/tmp', '--env', 'PATH=/usr/local/bin:/usr/bin:/bin',
    ...(limits.profile === 'repository' ? ['--env', 'CI=true', '--env', 'VITEST_MAX_WORKERS=1'] : []),
    // Docker's masked proc submounts prevent procfs mounts in a child user
    // namespace. This opt-in removes those system-path masks; an empty /sys
    // compensates for sysfs exposure, but does not restore the /proc masks.
    ...(seccomp === undefined ? [] : ['--security-opt', `seccomp=${seccomp.path}`,
      '--security-opt', 'systempaths=unconfined', '--tmpfs', '/sys:ro,nosuid,nodev,noexec,size=1m']),
    '--entrypoint', '/bin/sh', input.config.image, '-ceu', script]
  const git = spawn('/usr/bin/git', ['archive', '--format=tar', snapshot.tree], { cwd: input.worktree, env: input.environment, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
  const docker = spawn(dockerPath, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: { PATH: '/usr/bin:/bin' } })
  git.stderr.resume()
  docker.stdin!.on('error', () => { /* EPIPE is settled by the Docker exit result. */ })
  git.stdout.pipe(docker.stdin!)
  const dockerDone = new Promise<number | null>((resolvePromise, reject) => { docker.once('error', reject); docker.once('close', resolvePromise) })
  const gitDone = new Promise<void>((resolvePromise, reject) => { git.once('error', reject); git.once('close', code => code === 0 ? resolvePromise() : reject(new ControlPlaneCliError('EXECUTOR_FAILED', `source archive exited ${code}`))) })
  let stdout = ''; let stdoutBytes = 0; let stderr = ''; let overflow = false; let timedOut = false
  const add = (target: 'out' | 'err', chunk: Buffer): void => {
    if (target === 'err') { stderr = (stderr + chunk.toString('utf8')).slice(-4096); return }
    const remaining = input.config.outputBytes - stdoutBytes
    if (remaining > 0) stdout += chunk.subarray(0, remaining).toString('utf8')
    stdoutBytes += chunk.length
    if (stdoutBytes > input.config.outputBytes) { overflow = true; stop() }
  }
  docker.stdout!.on('data', (chunk: Buffer) => add('out', chunk)); docker.stderr!.on('data', (chunk: Buffer) => add('err', chunk))
  const stop = (): void => { git.kill('SIGKILL'); docker.kill('SIGKILL') }
  const abort = (): void => { timedOut = true; stop() }
  input.signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, input.config.timeoutMs)
  if (input.signal.aborted) abort()
  const started = Date.now()
  try {
    const [code] = await Promise.all([dockerDone, gitDone])
    await input.assertCurrent()
    if (timedOut || input.signal.aborted) throw new ControlPlaneCliError('EXECUTOR_TIMEOUT', 'isolated source build was cancelled or exceeded its deadline')
    if (overflow) throw new ControlPlaneCliError('EXECUTOR_OUTPUT_LIMIT', 'isolated source build exceeded its output bound')
    if (code !== 0) throw new ControlPlaneCliError('EXECUTOR_FAILED', `isolated source build failed (${code}): ${stderr.trimEnd()}`)
    const match = marker.exec(stdout)
    if (match !== null && stdout.trim() !== match[0]) throw new ControlPlaneCliError('EXECUTOR_FAILED', 'isolated source build emitted unexpected evidence output')
    if (match === null) throw new ControlPlaneCliError('EXECUTOR_FAILED', 'isolated source build did not emit its pack evidence marker')
    const checked = await checkedSourceSnapshot(input.worktree, input.baseCommit, input.scope, input.environment)
    if (checked.checkedTreeDigest !== before.checkedTreeDigest || checked.checkedPatchDigest !== before.checkedPatchDigest) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'prepared source changed while its isolated build was running')
    }
    const logDigest = createHash('sha256').update(stdout).update('\0').update(stderr).digest('hex')
    const checkedAt = Date.now()
    return { treeDigest: checked.checkedTreeDigest, patchDigest: checked.checkedPatchDigest, checkedAt,
      evidence: Object.freeze({ schemaVersion: 1, kind: 'dsh-source-prepared-evidence',
        environment: Object.freeze({ npmConfigIgnoreScripts: true, frozenLockfile: true, offline: true, nodeVersion: match[4]!, pnpmVersion: match[5]! }),
        commands: Object.freeze([{ command: 'docker', args: Object.freeze([...args]), exitCode: 0 as const, durationMs: Date.now() - started, logDigest }]),
        pack: Object.freeze({ name: match[1]!, sizeBytes: Number(match[2]), sha256: match[3]!, version: packageVersion }), preparedAt: input.preparedAt }) }
  } finally {
    clearTimeout(timer); input.signal.removeEventListener('abort', abort); stop()
    await Promise.allSettled([dockerDone, gitDone])
    try {
      // Failed inspect is ambiguous (daemon loss also exits nonzero). Require
      // a successful exact-name listing from the daemon to prove absence.
      if (input.sourceJob === undefined) await ensureContainerRemoved(dockerPath, container)
      else await removeSourceJobContainer(input.config, input.sourceJob)
    } finally { await snapshot.cleanup() }
  }
}

/** Reconcile only a labeled, image-bound durable container, then prove absence. */
export async function removeSourceJobContainer(config: SourceBuildConfig, job: { id: string; containerName: string }): Promise<void> {
  if (!/^source-job-[a-f0-9]{64}$/u.test(job.id) || job.containerName !== `dsh-${job.id}`) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'invalid durable container identity')
  validateSourceBuildConfig(config)
  const path = await verifiedDockerPath(config.dockerPath)
  const list = (): Promise<{ code: number | null; stdout: string }> => dockerControl(path, ['container', 'ls', '--all', '--quiet', '--filter', `name=^/${job.containerName}$`])
  const before = await list()
  if (before.code !== 0) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'durable container absence is unproven')
  if (before.stdout.trim() !== '') {
    const inspected = await dockerControl(path, ['inspect', '--format', '[{{json .Id}},{{json .Name}},{{json .Config.Image}},{{json (index .Config.Labels "dsh.source.job")}}]', job.containerName])
    if (inspected.code !== 0) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'durable container identity is unproven')
    const value: unknown = JSON.parse(inspected.stdout)
    if (!Array.isArray(value) || value.length !== 4 || typeof value[0] !== 'string' || !/^[a-f0-9]{64}$/u.test(value[0])
      || value[1] !== `/${job.containerName}` || value[2] !== config.image || value[3] !== job.id) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'durable container ownership mismatch')
    await dockerControl(path, ['rm', '-f', value[0]])
  }
  const after = await list()
  if (after.code !== 0 || after.stdout.trim() !== '') throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'durable container cleanup is unproven')
}

async function dockerControl(path: string, args: string[], signal?: AbortSignal): Promise<{ code: number | null; stdout: string }> {
  signal?.throwIfAborted()
  return new Promise((resolvePromise, reject) => {
    const child = spawn(path, args, { stdio: ['ignore', 'pipe', 'ignore'], shell: false, env: { PATH: '/usr/bin:/bin' } })
    let stdout = ''; let bytes = 0; let failed = false
    const abort = (): void => { child.kill('SIGKILL') }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL') }, 5_000)
    const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 4_096) { failed = true; child.kill('SIGKILL') }
      else stdout += chunk.toString('utf8')
    })
    child.once('error', () => { cleanup(); reject(new ControlPlaneCliError('EXECUTOR_FAILED', 'source build control client could not start')) })
    child.once('close', code => {
      cleanup()
      if (signal?.aborted) reject(new ControlPlaneCliError('EXECUTOR_TIMEOUT', 'source build control query was cancelled'))
      else if (failed) reject(new ControlPlaneCliError('EXECUTOR_FAILED', 'source build control query exceeded its resource bound'))
      else resolvePromise({ code, stdout })
    })
  })
}

async function ensureContainerRemoved(path: string, container: string): Promise<void> {
  await dockerControl(path, ['rm', '-f', container])
  const remaining = await dockerControl(path, ['container', 'ls', '--all', '--quiet', '--filter', `name=^/${container}$`])
  if (remaining.code !== 0 || remaining.stdout.trim() !== '') {
    throw new ControlPlaneCliError('EXECUTOR_FAILED', 'isolated source build container cleanup could not prove quiescence')
  }
}
