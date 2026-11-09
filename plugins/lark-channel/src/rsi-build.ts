import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { RsiSourceWorkspace } from './rsi-source.js'

const MAX_OUTPUT = 65_536
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

/** Docker-era source build shape, readable from historical stored intents only.
 * The current dispatch can never produce or execute this configuration. */
export interface LegacyDockerSourceBuildConfig {
  dockerPath: string
  socketPath?: string
  daemonId?: string
  image: string
  timeoutMs: number
  memoryMiB: number
  cpus: number
  pidsLimit: number
  workspaceMiB: number
  outputBytes: number
  versioning?: 'patch'
  profile?: 'standard' | 'repository' | 'portable-repository'
  temporaryMiB?: number
  repositorySandbox?: { seccompPath: string }
}

/** Historical schema 1 build environment. It may be decoded from persisted
 * receipts, but it can never be prepared, resumed or executed. */
export interface LegacyDockerSourceBuildEnvironment {
  schemaVersion: 1
  sourceCommit: string
  sourceBuild: LegacyDockerSourceBuildConfig
}

export class RsiBuildUnavailableError extends Error {
  readonly code = 'rsi-build-unavailable'
  constructor(message: string) { super(`rsi build unavailable: ${message}`) }
}

function fail(message: string): never { throw new Error(`rsi build: ${message}`) }
function diagnosticTail(value: string): string {
  const redacted = value.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/giu, 'https://[redacted]@')
    .replace(/authorization\s*:\s*[^\s]+/giu, 'authorization: [redacted]')
  return Array.from(redacted).map(char => {
    const code = char.codePointAt(0)!
    return code < 32 || code === 127 ? ' ' : char
  }).join('').slice(-2_048).trim()
}

async function directory(path: string, privateMode = true): Promise<void> {
  const item = await lstat(path)
  if (!item.isDirectory() || item.isSymbolicLink() || item.mode & (privateMode ? 0o077 : 0o022)
    || process.getuid && item.uid !== process.getuid() || await realpath(path) !== path) fail(`unsafe directory: ${path}`)
}
async function readStable(path: string, maximum: number, privateMode = false, allowRoot = false): Promise<Buffer> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await fd.stat()
    if (!before.isFile() || before.size > maximum || privateMode && before.mode & 0o077
      || process.getuid && before.uid !== process.getuid() && !(allowRoot && before.uid === 0)) fail(`unsafe file: ${path}`)
    const bytes = await fd.readFile(), after = await fd.stat(), name = await lstat(path)
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || name.dev !== before.dev || name.ino !== before.ino || name.isSymbolicLink()) fail(`file changed during read: ${path}`)
    return bytes
  } finally { await fd.close() }
}
async function writeExclusive(path: string, bytes: string | Buffer): Promise<void> {
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await fd.writeFile(bytes); await fd.sync() } finally { await fd.close() }
}
async function syncDirectory(path: string): Promise<void> {
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await fd.sync() } finally { await fd.close() }
}

/** Drain a cancelled subprocess, giving its own finally block time to clean up. */
async function command(executable: string, args: readonly string[], environment: NodeJS.ProcessEnv,
  signal: AbortSignal, timeoutMs: number, outputLimit = MAX_OUTPUT): Promise<string> {
  signal.throwIfAborted()
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  return new Promise<string>((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn>
    try { child = spawn(executable, [...args], { env: environment, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', windowsHide: true }) }
    catch { reject(new Error('rsi build: subprocess could not start')); return }
    let stdoutBytes = 0, overLimit = false, spawnError = false
    const stdout: Buffer[] = []
    let stderrTail = ''
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const group = (signalName: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        if (process.platform === 'win32') child.kill(signalName)
        else process.kill(-child.pid, signalName)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signalName) }
    }
    const abort = () => {
      group('SIGTERM')
      killTimer ??= setTimeout(() => group('SIGKILL'), 5_000)
      killTimer.unref?.()
    }
    deadline.addEventListener('abort', abort, { once: true })
    if (deadline.aborted) abort()
    const collect = (data: Buffer, keep: boolean) => {
      if (keep) {
        stdoutBytes += data.length
        if (stdoutBytes > outputLimit) { overLimit = true; group('SIGKILL'); return }
        stdout.push(data)
      } else {
        // Drain progress output without logging it or treating it as result data.
        stderrTail = (stderrTail + data.toString('utf8')).slice(-8_192)
      }
    }
    child.stdout!.on('data', data => collect(data, true))
    child.stderr!.on('data', data => collect(data, false))
    child.once('error', () => { spawnError = true; group('SIGKILL') })
    child.once('close', (code, killed) => {
      deadline.removeEventListener('abort', abort)
      if (killTimer) clearTimeout(killTimer)
      if (spawnError || overLimit || deadline.aborted || code !== 0 || killed !== null) {
        // Git calls lead with `-c key=value` / `-C dir`; name the subcommand instead.
        const gitIndex = executable.endsWith('/git') ? args.findIndex((arg, index) =>
          !arg.startsWith('-') && args[index - 1] !== '-c' && args[index - 1] !== '-C') : -1
        const stage = gitIndex >= 0 ? `git-${args[gitIndex]}${overLimit ? '-output-limit' : ''}` : args[0] ?? 'command'
        const tail = diagnosticTail(stderrTail)
        reject(new Error(`rsi build: subprocess failed, was cancelled, or exceeded its bound (stage=${stage}, exit=${code ?? 'signal'}${tail ? `, stderr=${tail}` : ''})`))
      }
      else resolvePromise(Buffer.concat(stdout).toString('utf8').trim())
    })
  })
}

// Shared by the native release/creation/locality modules; these helpers never
// change a profile and no longer provide any container runtime seam.
export const rsiBuildResources = { directory, readStable, writeExclusive, syncDirectory, command }

function digest(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function exactPath(path: string): boolean { return isAbsolute(path) && resolve(path) === path && !path.includes('\0') }
function legacySourceBuild(value: unknown): value is LegacyDockerSourceBuildConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const config = value as Record<string, unknown>
  return !Object.hasOwn(config, 'backend') && typeof config.dockerPath === 'string' && config.dockerPath.startsWith('/')
    && typeof config.image === 'string' && config.image.length > 0 && config.image.length <= 256
    && Object.keys(config).every(key => ['dockerPath', 'socketPath', 'daemonId', 'image', 'timeoutMs', 'memoryMiB',
      'cpus', 'pidsLimit', 'workspaceMiB', 'outputBytes', 'versioning', 'profile', 'temporaryMiB',
      'repositorySandbox'].includes(key))
}

/** Decode a persisted Docker-era build receipt without creating resources,
 * validating a client or invoking any container. This is the read-only replay
 * seam used when a candidate Home still carries the legacy `rsi-builds` tree;
 * it can never continue that build. */
export async function readRsiBuildEnvironment(input: { dshHome: string; profile: string;
  source: RsiSourceWorkspace; signal?: AbortSignal }): Promise<LegacyDockerSourceBuildEnvironment> {
  if (!exactPath(input.dshHome) || !PROFILE.test(input.profile)) fail('invalid DSH_HOME or profile')
  input.signal?.throwIfAborted()
  await directory(input.dshHome, false)
  const repository = join(input.dshHome, 'rsi-sources', input.profile, 'checkout')
  if (input.source.repository !== repository) fail('source workspace does not belong to the recorded Home')
  const parent = join(input.dshHome, 'rsi-builds'), final = join(parent, input.profile)
  await directory(parent); await directory(final)
  const saved = JSON.parse((await readStable(join(final, 'bootstrap.json'), 65_536, true)).toString('utf8')) as
    Record<string, unknown>
  const { receiptDigest: recordedDigest, ...content } = saved
  if (saved.schemaVersion !== 1 || recordedDigest !== digest(JSON.stringify(content))
    || saved.sourceCommit !== input.source.sourceCommit || !legacySourceBuild(saved.sourceBuild)) {
    fail('recorded Docker build receipt is invalid or does not match the source')
  }
  input.signal?.throwIfAborted()
  return { schemaVersion: 1, sourceCommit: saved.sourceCommit as string,
    sourceBuild: saved.sourceBuild }
}
