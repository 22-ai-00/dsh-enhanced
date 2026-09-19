import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
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
}

export interface SourceBuildResult {
  treeDigest: string
  patchDigest: string
  checkedAt: number
  evidence: SourcePreparedEvidence
}

const imageDigest = /^(?:[a-z0-9][a-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/u
const marker = /^DSH_PREPARED_PACK\t([^\t\n]+)\t([0-9]+)\t([a-f0-9]{64})\t([^\t\n]+)\t([^\t\n]+)$/mu

export function validateSourceBuildConfig(config: SourceBuildConfig): void {
  if (config === null || typeof config !== 'object' || Array.isArray(config) || typeof config.image !== 'string' || config.image.length > 256 || !imageDigest.test(config.image) || typeof config.dockerPath !== 'string' || !config.dockerPath.startsWith('/') || config.dockerPath.includes('\0')
    || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 60_000 || config.timeoutMs > 240_000
    || !Number.isSafeInteger(config.memoryMiB) || config.memoryMiB < 128 || config.memoryMiB > 4096
    || !Number.isSafeInteger(config.pidsLimit) || config.pidsLimit < 16 || config.pidsLimit > 512
    || !Number.isFinite(config.cpus) || config.cpus < 0.25 || config.cpus > 4
    || !Number.isSafeInteger(config.workspaceMiB) || config.workspaceMiB < 64 || config.workspaceMiB > 2048
    || !Number.isSafeInteger(config.outputBytes) || config.outputBytes < 4096 || config.outputBytes > 1_048_576) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source build configuration is invalid')
  }
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

async function sourceTree(worktree: string, baseCommit: string, scope: readonly string[], environment: NodeJS.ProcessEnv): Promise<{ tree: string; cleanup: () => Promise<void> }> {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-source-build-index-'))
  try {
    const env = { ...environment, GIT_INDEX_FILE: join(temporary, 'index') }
    await runLocalCommand('git', ['read-tree', baseCommit], worktree, env)
    await runLocalCommand('git', ['--literal-pathspecs', 'add', '--all', '--', ...scope], worktree, env)
    const tree = (await runLocalCommand('git', ['write-tree'], worktree, env, { capture: true })).trim()
    if (!/^[a-f0-9]{40}$/u.test(tree)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'temporary source tree is invalid')
    return { tree, cleanup: async () => { await rm(temporary, { recursive: true, force: true }) } }
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
}): Promise<SourceBuildResult> {
  validateSourceBuildConfig(input.config); const dockerPath = await verifiedDockerPath(input.config.dockerPath); await input.assertCurrent()
  const snapshot = await sourceTree(input.worktree, input.baseCommit, input.scope, input.environment)
  let before: Awaited<ReturnType<typeof checkedSourceSnapshot>>
  let packageVersion: string
  try {
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
  const container = `dsh-source-prepare-${randomUUID()}`
  const script = 'set -eu; umask 077; mkdir -p /workspace; tar -x -C /workspace; cd /workspace; pnpm install --offline --frozen-lockfile --ignore-scripts >/tmp/install.log 2>&1; pnpm check >/tmp/check.log 2>&1; mkdir -p /workspace/.dsh-pack; cd "$PLUGIN_ROOT"; pnpm pack --pack-destination /workspace/.dsh-pack >/tmp/pack.log 2>&1; set -- /workspace/.dsh-pack/*.tgz; test "$#" = 1; pack="$1"; printf "DSH_PREPARED_PACK\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "${pack##*/}" "$(wc -c < "$pack" | tr -d " ")" "$(sha256sum "$pack" | cut -d " " -f1)" "$(node --version)" "$(pnpm --version)"'
  const args = ['run', '-i', '--pull', 'never', '--name', container, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--pids-limit', String(input.config.pidsLimit),
    '--memory', `${input.config.memoryMiB}m`, '--memory-swap', `${input.config.memoryMiB}m`, '--cpus', String(input.config.cpus),
    '--tmpfs', `/workspace:rw,nosuid,nodev,mode=1777,size=${input.config.workspaceMiB}m`, '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777,size=32m',
    '--workdir', '/workspace', '--env', `PLUGIN_ROOT=plugins/${input.name}`, '--env', 'HOME=/tmp', '--env', 'PATH=/usr/local/bin:/usr/bin:/bin',
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
        commands: Object.freeze([{ command: 'docker', args: Object.freeze(['run', '--network', 'none', '--read-only', '--cap-drop', 'ALL', input.config.image, snapshot.tree]), exitCode: 0 as const, durationMs: Date.now() - started, logDigest }]),
        pack: Object.freeze({ name: match[1]!, sizeBytes: Number(match[2]), sha256: match[3]!, version: packageVersion }), preparedAt: input.preparedAt }) }
  } finally {
    clearTimeout(timer); input.signal.removeEventListener('abort', abort); stop()
    await Promise.allSettled([dockerDone, gitDone])
    try {
      // Failed inspect is ambiguous (daemon loss also exits nonzero). Require
      // a successful exact-name listing from the daemon to prove absence.
      await ensureContainerRemoved(dockerPath, container)
    } finally { await snapshot.cleanup() }
  }
}

async function dockerControl(path: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(path, args, { stdio: ['ignore', 'pipe', 'ignore'], shell: false, env: { PATH: '/usr/bin:/bin' } })
    let stdout = ''; let bytes = 0; let failed = false
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL') }, 5_000)
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 4_096) { failed = true; child.kill('SIGKILL') }
      else stdout += chunk.toString('utf8')
    })
    child.once('error', () => { clearTimeout(timer); reject(new ControlPlaneCliError('EXECUTOR_FAILED', 'source build cleanup client could not start')) })
    child.once('close', code => {
      clearTimeout(timer)
      if (failed) reject(new ControlPlaneCliError('EXECUTOR_FAILED', 'source build cleanup exceeded its resource bound'))
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
