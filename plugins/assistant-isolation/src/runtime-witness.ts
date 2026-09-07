import type { SystemdBinding } from './daemon-binding.js'
import { spawn } from 'node:child_process'
import { constants, readFileSync } from 'node:fs'
import { chmod, lstat, mkdtemp, open, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export interface ProcessWitness { bootId: string; pid: number; startTicks: string }
export interface DaemonWitness { process: ProcessWitness; engineId: string; dockerPath: string; socketPath: string; pidFile: string }
export interface CreationWitness {
  daemon: DaemonWitness
  supervisor: ProcessWitness
  /** Present only after the supervisor has reaped every CLI it started. */
  requestsSettled?: boolean
  binding?: SystemdBinding
}

const bootIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
const ticksPattern = /^[1-9][0-9]{0,63}$/
const engineIdPattern = /^[A-Za-z0-9:-]{1,256}$/
const pathMaximum = 4096
const defaultSocketPath = '/var/run/docker.sock'
const defaultPidFile = '/run/docker.pid'

const validPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= pathMaximum && isAbsolute(value) && !/[\p{Cc}]/u.test(value)
const validProcess = (value: unknown): value is ProcessWitness => !!value && typeof value === 'object'
  && Object.keys(value).length === 3 && typeof (value as ProcessWitness).bootId === 'string' && bootIdPattern.test((value as ProcessWitness).bootId)
  && Number.isSafeInteger((value as ProcessWitness).pid) && (value as ProcessWitness).pid > 0
  && typeof (value as ProcessWitness).startTicks === 'string' && ticksPattern.test((value as ProcessWitness).startTicks)

export function validateCreationWitness(value: unknown): CreationWitness {
  if (!value || typeof value !== 'object' || ![2, 3, 4].includes(Object.keys(value).length) || Object.keys(value).some(key => !['daemon', 'supervisor', 'requestsSettled', 'binding'].includes(key)) || !validProcess((value as CreationWitness).supervisor)) throw new TypeError('invalid creation witness')
  const daemon = (value as CreationWitness).daemon
  if (!daemon || typeof daemon !== 'object' || Object.keys(daemon).length !== 5 || !validProcess(daemon.process)
    || typeof daemon.engineId !== 'string' || !engineIdPattern.test(daemon.engineId)
    || !validPath(daemon.dockerPath) || !validPath(daemon.socketPath) || !validPath(daemon.pidFile)) throw new TypeError('invalid creation witness')
  if (daemon.process.bootId !== (value as CreationWitness).supervisor.bootId) throw new TypeError('creation witness crosses boot generations')
  const witness = value as CreationWitness
  if (witness.requestsSettled !== undefined && typeof witness.requestsSettled !== 'boolean') throw new TypeError('invalid settlement proof')
  if (witness.binding !== undefined && (!witness.binding || Object.keys(witness.binding).length !== 3 || witness.binding.kind !== 'systemd'
    || !/^[0-9a-f]{32}$/.test(witness.binding.serviceInvocationId) || !/^[0-9a-f]{32}$/.test(witness.binding.socketInvocationId))) throw new TypeError('invalid daemon binding')
  return { ...(witness.requestsSettled === undefined ? {} : { requestsSettled: witness.requestsSettled }),
    ...(witness.binding === undefined ? {} : { binding: { ...witness.binding } }), daemon: { process: { ...daemon.process }, engineId: daemon.engineId, dockerPath: daemon.dockerPath, socketPath: daemon.socketPath, pidFile: daemon.pidFile }, supervisor: { ...(value as CreationWitness).supervisor } }
}

async function bootId(): Promise<string | undefined> {
  try { const value = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim().toLowerCase(); return bootIdPattern.test(value) ? value : undefined } catch { return undefined }
}

type Proc = ProcessWitness & { comm: string; state: string; uid: number }
async function proc(pid: number): Promise<Proc | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    const [currentBootId, raw, metadata] = await Promise.all([bootId(), readFile(`/proc/${pid}/stat`, 'utf8'), stat(`/proc/${pid}`)])
    const close = raw.lastIndexOf(') '); const opening = raw.indexOf('(')
    if (!currentBootId || opening < 0 || close <= opening || !Number.isSafeInteger(metadata.uid)) return undefined
    const fields = raw.slice(close + 2).trim().split(/\s+/)
    const startTicks = fields[19]
    if (!startTicks || !ticksPattern.test(startTicks) || !fields[0]) return undefined
    return { bootId: currentBootId, pid, startTicks, comm: raw.slice(opening + 1, close), state: fields[0], uid: metadata.uid }
  } catch { return undefined }
}

export async function processWitness(pid = process.pid): Promise<ProcessWitness | undefined> {
  const value = await proc(pid)
  return value ? { bootId: value.bootId, pid: value.pid, startTicks: value.startTicks } : undefined
}

export function processExited(witness: ProcessWitness): boolean {
  if (!validProcess(witness)) return false
  let currentBootId: string
  try {
    currentBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim().toLowerCase()
  } catch { return false }
  if (!bootIdPattern.test(currentBootId)) return false
  if (currentBootId !== witness.bootId) return true
  try {
    const raw = readFileSync(`/proc/${witness.pid}/stat`, 'utf8')
    const close = raw.lastIndexOf(') ')
    if (close < 0) return false
    const fields = raw.slice(close + 2).trim().split(/\s+/)
    // A zombie retains its proc entry; it is not proof that all waiters reaped it.
    if (fields[0] === 'Z' || !fields[19] || !ticksPattern.test(fields[19])) return false
    return fields[19] !== witness.startTicks
  } catch (error: unknown) {
    return !!error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT'
  }
}

type PidFile = { path: string; pid: number; uid: number; dev: number; ino: number }
async function stablePidFile(path: string): Promise<PidFile | undefined> {
  if (!validPath(path)) return undefined
  try {
    const canonical = await realpath(path)
    if (!isAbsolute(canonical)) return undefined
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o022) !== 0 || (before.uid !== 0 && before.uid !== process.getuid?.()) || before.size < 1 || before.size >= 64) return undefined
      const bytes = Buffer.alloc(64); const read = await handle.read(bytes, 0, bytes.length, 0)
      const after = await handle.stat()
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return undefined
      const text = bytes.subarray(0, read.bytesRead).toString('ascii').trim()
      if (!/^[1-9][0-9]{0,15}$/.test(text)) return undefined
      const pid = Number(text)
      return Number.isSafeInteger(pid) && pid > 0 ? { path: canonical, pid, uid: before.uid, dev: before.dev, ino: before.ino } : undefined
    } finally { await handle.close() }
  } catch { return undefined }
}

type Socket = { path: string; dev: number; ino: number }
async function canonicalSocket(path: string): Promise<Socket | undefined> {
  if (!validPath(path)) return undefined
  try { const canonical = await realpath(path); const info = await lstat(canonical); return isAbsolute(canonical) && info.isSocket() ? { path: canonical, dev: info.dev, ino: info.ino } : undefined } catch { return undefined }
}

async function canonicalExecutable(path: string): Promise<string | undefined> {
  if (!validPath(path)) return undefined
  try { const canonical = await realpath(path); const info = await stat(canonical); return isAbsolute(canonical) && info.isFile() && (info.mode & 0o111) !== 0 ? canonical : undefined } catch { return undefined }
}

async function engineId(dockerPath: string, socketPath: string): Promise<string | undefined> {
  let directory: string | undefined
  try {
    directory = await mkdtemp(join(tmpdir(), 'dsh-isolation-docker-')); await chmod(directory, 0o700)
    return await new Promise(resolve => {
      let output = Buffer.alloc(0); let done = false
      const finish = (value: string | undefined): void => { if (done) return; done = true; clearTimeout(timer); resolve(value) }
      const child = spawn(dockerPath, ['--config', directory!, '-H', `unix://${socketPath}`, 'info', '--format', '{{.ID}}'], { shell: false, env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] })
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(undefined) }, 5_000); timer.unref()
      child.stdout.on('data', (chunk: Buffer) => { if (output.length + chunk.length > 4096) { child.kill('SIGKILL'); finish(undefined) } else output = Buffer.concat([output, chunk]) })
      child.once('error', () => finish(undefined))
      child.once('close', code => { const value = output.toString('utf8').trim(); finish(code === 0 && engineIdPattern.test(value) ? value : undefined) })
    })
  } catch { return undefined } finally { if (directory !== undefined) await rm(directory, { recursive: true, force: true }).catch(() => undefined) }
}

export async function captureDaemonWitness({ dockerPath, socketPath = defaultSocketPath, pidFile = defaultPidFile }: { dockerPath: string; socketPath?: string; pidFile?: string }): Promise<DaemonWitness | undefined> {
  const [executable, socket, pid] = await Promise.all([canonicalExecutable(dockerPath), canonicalSocket(socketPath), stablePidFile(pidFile)])
  if (!executable || !socket || !pid) return undefined
  const first = await proc(pid.pid)
  if (!first || first.comm !== 'dockerd' || first.uid !== pid.uid || first.state === 'Z') return undefined
  const id = await engineId(executable, socket.path)
  const [recheckedPid, recheckedSocket] = await Promise.all([stablePidFile(pidFile), canonicalSocket(socketPath)])
  const second = await proc(pid.pid)
  if (!id || !recheckedPid || !recheckedSocket || recheckedPid.path !== pid.path || recheckedPid.dev !== pid.dev || recheckedPid.ino !== pid.ino || recheckedPid.pid !== pid.pid || recheckedPid.uid !== pid.uid
    || recheckedSocket.path !== socket.path || recheckedSocket.dev !== socket.dev || recheckedSocket.ino !== socket.ino
    || !second || second.comm !== 'dockerd' || second.uid !== pid.uid || second.state === 'Z' || first.bootId !== second.bootId || first.startTicks !== second.startTicks) return undefined
  return { process: { bootId: second.bootId, pid: second.pid, startTicks: second.startTicks }, engineId: id, dockerPath: executable, socketPath: socket.path, pidFile: pid.path }
}

function validDaemon(value: unknown): value is DaemonWitness {
  return !!value && typeof value === 'object' && Object.keys(value).length === 5 && validProcess((value as DaemonWitness).process)
    && typeof (value as DaemonWitness).engineId === 'string' && engineIdPattern.test((value as DaemonWitness).engineId)
    && validPath((value as DaemonWitness).dockerPath) && validPath((value as DaemonWitness).socketPath) && validPath((value as DaemonWitness).pidFile)
}

export function sameDaemonWitness(a: DaemonWitness, b: DaemonWitness): boolean {
  if (!validDaemon(a) || !validDaemon(b)) return false
  return a.process.bootId === b.process.bootId && a.process.pid === b.process.pid && a.process.startTicks === b.process.startTicks && a.engineId === b.engineId && a.dockerPath === b.dockerPath && a.socketPath === b.socketPath && a.pidFile === b.pidFile
}

/** Diagnostic candidate only: does not prove socket ownership or authorize quota release. */
export async function eligibleRestartWitness(original: CreationWitness): Promise<DaemonWitness | undefined> {
  let value: CreationWitness
  try { value = validateCreationWitness(original) } catch { return undefined }
  if (!processExited(value.supervisor) || !processExited(value.daemon.process)) return undefined
  const current = await captureDaemonWitness({ dockerPath: value.daemon.dockerPath, socketPath: value.daemon.socketPath, pidFile: value.daemon.pidFile })
  if (!current || current.engineId !== value.daemon.engineId || current.dockerPath !== value.daemon.dockerPath || current.socketPath !== value.daemon.socketPath || current.pidFile !== value.daemon.pidFile) return undefined
  return current.process.bootId === value.daemon.process.bootId && current.process.pid === value.daemon.process.pid && current.process.startTicks === value.daemon.process.startTicks ? undefined : current
}
