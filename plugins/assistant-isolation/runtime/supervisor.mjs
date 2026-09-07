import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOCKET = 'unix:///var/run/docker.sock'
const OPERATION_TIMEOUT_MS = 10_000
const NAME = /^dsh-isolation-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
const IMAGE = /^sha256:[0-9a-f]{64}$/
let config
let workerOwned = false
let keeperOwned = false
let volumeOwned = false
let started = false
let finalizing = false
let complete = false
let deadlineTimer
let stdout = ''
let stderr = ''
let dockerDirectory
let provisioning = Promise.resolve()
let cancelReason
let creationAmbiguous = false
let mutationAmbiguous = false
let requestsSettled = true
const activeCommands = new Set()
const workerName = () => config.containerName
const keeperName = () => `${workerName()}-keeper`
const volumeName = () => `${workerName()}-workspace`

function environment() {
  return { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }
}
function send(message) {
  if (process.connected) { try { process.send(message) } catch {} }
}
function decode(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
  catch { return undefined }
}
function succeeded(result) {
  return result.code === 0 && !result.timeout && !result.overflow
}
function docker(args, { outputLimit = 65_536, timeoutMs = OPERATION_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let child
    let out = Buffer.alloc(0)
    let err = Buffer.alloc(0)
    let overflow = false
    let timeout = false
    let settled = false
    let timer
    const finish = result => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      const mutating = ['create', 'start', 'cp', 'exec'].includes(args[0]) || (args[0] === 'volume' && args[1] === 'create')
      if (mutating && (timeout || overflow || result.code === null)) mutationAmbiguous = true
      if (mutating && (timeout || overflow || result.code !== 0 || result.signal || result.error)) requestsSettled = false
      const decoded = decode(out)
      resolve({ ...result, stdout: decoded ?? '', stderr: decode(err) ?? '', stdoutBytes: out.length,
        stdoutUtf8: decoded !== undefined, overflow, timeout })
    }
    try {
      child = spawn(config.dockerPath, ['--config', dockerDirectory, '-H', SOCKET, ...args], {
        shell: false, env: environment(), stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) { finish({ code: null, error: String(error) }); return }
    activeCommands.add(child)
    child.once('close', () => activeCommands.delete(child))
    const collect = (target, chunk) => {
      const kept = chunk.subarray(0, Math.max(0, outputLimit - out.length - err.length))
      if (target === 'out') out = Buffer.concat([out, kept])
      else err = Buffer.concat([err, kept])
      if (kept.length !== chunk.length && !overflow) { overflow = true; child.kill('SIGTERM') }
    }
    child.stdout.on('data', chunk => collect('out', chunk))
    child.stderr.on('data', chunk => collect('err', chunk))
    child.once('error', error => finish({ code: null, error: error.message }))
    // close, not exit: collect the final pipe bytes before accepting an artifact.
    child.once('close', (code, signal) => finish({ code, signal }))
    timer = setTimeout(() => { timeout = true; child.kill('SIGKILL') }, timeoutMs)
    timer.unref()
  })
}
async function absent(type, name) {
  const result = await docker(['inspect', '--type', type, name])
  return !result.timeout && !result.overflow && result.code !== 0
    && /no such (object|container|volume)/i.test(result.stderr)
}
async function erase(type, name) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await docker(type === 'volume' ? ['volume', 'rm', name] : ['rm', '-f', name])
    if (succeeded(result) || await absent(type, name)) return true
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}
async function removeWorker() {
  if (!workerOwned) return true
  await docker(['kill', workerName()])
  return erase('container', workerName())
}
async function removeStorage() {
  const keeperRemoved = !keeperOwned || await erase('container', keeperName())
  const volumeRemoved = !volumeOwned || await erase('volume', volumeName())
  return keeperRemoved && volumeRemoved
}
function artifactPath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.startsWith('/')
    && !/[\p{Cc}\\]/u.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..')
}
function exportInterruption() {
  if (cancelReason !== undefined) return cancelReason
  return Date.now() >= config.deadline ? 'deadline-expired' : undefined
}
function exportTimeout() {
  return Math.max(1, Math.min(OPERATION_TIMEOUT_MS, config.deadline - Date.now()))
}
async function stat(path, regular) {
  if (exportInterruption()) return undefined
  const result = await docker(['exec', keeperName(), '/bin/busybox', 'stat', '-c', '%f:%h:%s', '--', path], { timeoutMs: exportTimeout() })
  if (!succeeded(result) || exportInterruption() || !/^[0-9a-fA-F]+:\d+:\d+\n?$/.test(result.stdout)) return undefined
  const fields = result.stdout.trim().split(':')
  const mode = Number.parseInt(fields[0], 16)
  const links = Number(fields[1])
  const size = Number(fields[2])
  if (![mode, links, size].every(Number.isSafeInteger)) return undefined
  // BusyBox stat without -L examines the link itself. Each parent is examined
  // separately after worker removal, so no worker can race path resolution.
  if (regular ? (mode & 0o170000) !== 0o100000 || links !== 1 : (mode & 0o170000) !== 0o40000) return undefined
  return { size }
}
async function exportArtifacts() {
  const files = []
  let total = 0
  for (const path of config.artifacts) {
    if (exportInterruption() || !artifactPath(path)) return undefined
    let parent = '/workspace'
    if (!await stat(parent, false)) return undefined
    const parts = path.split('/')
    for (const part of parts.slice(0, -1)) {
      parent += `/${part}`
      if (!await stat(parent, false)) return undefined
    }
    const target = `/workspace/${path}`
    const entry = await stat(target, true)
    if (!entry || entry.size > config.limits.maxArtifactBytes - total || exportInterruption()) return undefined
    const result = await docker(['exec', keeperName(), '/bin/busybox', 'cat', '--', target], {
      outputLimit: entry.size, timeoutMs: exportTimeout(),
    })
    if (!succeeded(result) || !result.stdoutUtf8 || result.stdoutBytes !== entry.size || exportInterruption()) return undefined
    total += entry.size
    files.push({ path, content: result.stdout })
  }
  return files
}
async function finish(status, reason, exitCode) {
  if (finalizing) return
  finalizing = true
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
  // Cleanup cannot overtake a create/copy request still owned by this process.
  await provisioning
  const workerRemoved = await removeWorker()
  let artifacts = []
  if (status === 'succeeded' && workerRemoved && keeperOwned) {
    const exported = await exportArtifacts()
    const interrupted = exportInterruption()
    if (interrupted !== undefined) {
      status = interrupted === 'deadline-expired' ? 'timed-out' : 'cancelled'
      reason = interrupted
    } else if (exported === undefined) {
      status = 'failed'
      reason = 'artifact-export-rejected'
    } else artifacts = exported
  }
  const storageRemoved = await removeStorage()
  // A final receipt must not outrun an attached start or other CLI still alive.
  // No new create can follow provisioning; begin() stops when finalizing is set.
  const outstanding = [...activeCommands]
  await Promise.all(outstanding.map(child => new Promise(resolve => child.once('close', resolve))))
  // A timed-out CLI can leave an in-flight daemon create request. A momentary
  // absence is not a release receipt for such a request; retain its reservation.
  const quiescent = workerRemoved && storageRemoved && !mutationAmbiguous
  if (creationAmbiguous) reason = 'docker-creation-unconfirmed'
  else if (mutationAmbiguous) reason = 'docker-mutation-unconfirmed'
  if (!quiescent || status !== 'succeeded') artifacts = []
  if (dockerDirectory !== undefined) await rm(dockerDirectory, { recursive: true, force: true }).catch(() => undefined)
  complete = true
  send({ type: 'result', settlementProtocol: 'all-cli-closed/v1', requestsSettled: requestsSettled && !mutationAmbiguous, result: { status: quiescent ? status : 'unknown', quiescent,
    ...(exitCode === undefined ? {} : { exitCode }), stdout, stderr, artifacts,
    ...(reason === undefined ? {} : { reason }) } })
  if (process.connected) process.disconnect()
}
async function begin() {
  const attached = await docker(['start', '--attach', workerName()], {
    outputLimit: config.limits.maxOutputBytes, timeoutMs: Math.max(1, config.deadline - Date.now()),
  })
  stdout = attached.stdout
  stderr = attached.stderr
  if (finalizing) return
  if (attached.overflow) { await finish('failed', 'output-limit-exceeded'); return }
  if (attached.timeout) { await finish('unknown', 'docker-start-timeout'); return }
  const inspected = await docker(['inspect', '--type', 'container', '--format', '{{json .State}}', workerName()])
  let state
  try { state = JSON.parse(inspected.stdout) } catch {}
  if (!succeeded(inspected) || typeof state?.Running !== 'boolean' || state.Running || !Number.isSafeInteger(state.ExitCode)) {
    await finish('unknown', 'container-state-unconfirmed')
    return
  }
  await finish(state.ExitCode === 0 ? 'succeeded' : 'failed', state.ExitCode === 0 ? undefined : 'container-exited-nonzero', state.ExitCode)
}
function valid(input) {
  return input && NAME.test(input.containerName) && IMAGE.test(input.image)
    && typeof input.dockerPath === 'string' && input.dockerPath.startsWith('/')
    && typeof input.workspacePath === 'string' && input.workspacePath.startsWith('/') && !/[\p{Cc},]/u.test(input.workspacePath)
    && typeof input.command === 'string' && Number.isSafeInteger(input.deadline)
    && input.limits && Object.values(input.limits).every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)
    && Array.isArray(input.artifacts) && input.artifacts.length <= input.limits.maxFiles && input.artifacts.every(artifactPath)
}
function sandbox(keeper = false) {
  const memory = keeper ? '32m' : `${Math.floor(config.limits.memoryMiB)}m`
  const flags = ['--network', 'none', '--read-only', '--log-driver', 'none', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--user', `${process.getuid()}:${process.getgid()}`,
    '--pids-limit', keeper ? '16' : String(Math.floor(config.limits.pidsLimit)), '--memory', memory, '--memory-swap', memory,
    '--shm-size', '1m', '--cpus', String(config.limits.cpus)]
  if (!keeper) {
    const tmpMiB = Math.max(1, Math.min(64, Math.floor(config.limits.memoryMiB / 4)))
    flags.push('--tmpfs', `/tmp:rw,nosuid,nodev,size=${tmpMiB}m,nr_inodes=${Math.floor(config.limits.workspaceInodes)}`)
  }
  return flags
}
function creationResult(result) {
  if (result.timeout || result.overflow || result.code === null) creationAmbiguous = true
  return !finalizing && succeeded(result)
}
async function provision() {
  const inspected = await docker(['image', 'inspect', '--format', '{{json .Config.Volumes}}', config.image])
  if (finalizing || !succeeded(inspected) || !['null', '{}'].includes(inspected.stdout.trim())) return false
  // Mark each unique resource owned before sending its create request, including
  // the timeout / lost-ack window. No resource name comes from the model.
  volumeOwned = true
  const options = `o=size=${Math.floor(config.limits.workspaceMiB)}m,nr_inodes=${Math.floor(config.limits.workspaceInodes)},uid=${process.getuid()},gid=${process.getgid()},mode=0700,nosuid,nodev`
  if (!creationResult(await docker(['volume', 'create', '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', options, volumeName()]))) return false
  keeperOwned = true
  if (!creationResult(await docker(['create', '--pull', 'never', '--name', keeperName(), ...sandbox(true),
    '--mount', `type=volume,src=${volumeName()},dst=/workspace,volume-nocopy`, '--entrypoint', '/bin/busybox', config.image, 'sleep', '3600']))) return false
  if (!succeeded(await docker(['start', keeperName()])) || finalizing) return false
  if (!succeeded(await docker(['cp', '-a', `${config.workspacePath}/.`, `${keeperName()}:/workspace`])) || finalizing) return false
  workerOwned = true
  return creationResult(await docker(['create', '--pull', 'never', '--name', workerName(), ...sandbox(),
    '--mount', `type=volume,src=${volumeName()},dst=/workspace,volume-nocopy`, '--workdir', '/workspace',
    '--entrypoint', '/bin/sh', config.image, '-c', config.command]))
}
async function configure(input) {
  if (config !== undefined || !valid(input)) { send({ type: 'error', reason: 'invalid-supervisor-config' }); return }
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || typeof process.getgid !== 'function' || process.getuid() === 0) {
    send({ type: 'error', reason: 'non-root-linux-host-required' })
    return
  }
  config = input
  try {
    dockerDirectory = await mkdtemp(join(tmpdir(), 'dsh-isolation-docker-'))
    await chmod(dockerDirectory, 0o700)
  } catch { await finish('failed', 'docker-config-directory-unavailable'); return }
  if (finalizing) { await rm(dockerDirectory, { recursive: true, force: true }).catch(() => undefined); return }
  if (config.deadline <= Date.now()) { await finish('timed-out', 'deadline-expired-before-create'); return }
  deadlineTimer = setTimeout(() => { void finish('timed-out', 'deadline-expired') }, config.deadline - Date.now())
  deadlineTimer.unref()
  let markSettled
  provisioning = new Promise(resolve => { markSettled = resolve })
  let prepared = false
  try { prepared = await provision() } finally { markSettled() }
  if (finalizing) return
  if (!prepared) { await finish('failed', 'docker-create-failed'); return }
  if (!process.connected) { await finish('unknown', 'parent-disconnected-before-authorization'); return }
  send({ type: 'ready' })
}
process.on('message', message => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'configure') void configure(message.config)
  else if (message.type === 'start' && config !== undefined && !finalizing && !started) { started = true; void begin() }
  else if (message.type === 'cancel' && config !== undefined) {
    cancelReason = typeof message.reason === 'string' ? message.reason : 'cancelled'
    void finish(cancelReason === 'deadline-expired' ? 'timed-out' : 'cancelled', cancelReason)
  }
})
process.on('disconnect', () => {
  if (config !== undefined && !complete) { cancelReason = 'parent-ipc-disconnected'; void finish('unknown', cancelReason) }
})
