import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOCKET = 'unix:///var/run/docker.sock'
const OPERATION_TIMEOUT_MS = 10_000
const NAME = /^dsh-isolation-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
const IMAGE = /^sha256:[0-9a-f]{64}$/

let config
let created = false
let started = false
let finalizing = false
let complete = false
let deadlineTimer
let stdout = ''
let stderr = ''
let dockerConfigDirectory
let creationSettled = Promise.resolve()

function environment() {
  return { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }
}

function send(message) {
  if (process.connected) { try { process.send(message) } catch {} }
}

function boundedText(buffer, limit) {
  // Decode complete UTF-8 only. Invalid/binary output never expands into an
  // unbounded sequence of replacement characters on the Host boundary.
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, limit)) }
  catch { return '' }
}

function docker(args, options = {}) {
  const limit = options.outputLimit ?? 64 * 1024
  const timeoutMs = options.timeoutMs ?? OPERATION_TIMEOUT_MS
  return new Promise((resolve) => {
    let child
    let out = Buffer.alloc(0)
    let err = Buffer.alloc(0)
    let overflow = false
    let timeout = false
    let settled = false
    let timer
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve({ ...value, stdout: boundedText(out, limit), stderr: boundedText(err, Math.max(0, limit - out.length)), overflow, timeout })
    }
    try {
      child = spawn(config.dockerPath, ['--config', dockerConfigDirectory, '-H', SOCKET, ...args], { shell: false, env: environment(), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) { finish({ code: null, error: String(error) }); return }
    const collect = (target, chunk) => {
      const available = Math.max(0, limit - out.length - err.length)
      const kept = chunk.subarray(0, available)
      if (target === 'out') out = Buffer.concat([out, kept])
      else err = Buffer.concat([err, kept])
      if (kept.length !== chunk.length && !overflow) { overflow = true; child.kill('SIGTERM') }
    }
    child.stdout.on('data', chunk => collect('out', chunk))
    child.stderr.on('data', chunk => collect('err', chunk))
    child.once('error', error => finish({ code: null, error: error.message }))
    child.once('exit', (code, signal) => finish({ code, signal }))
    timer = setTimeout(() => { timeout = true; child.kill('SIGKILL') }, timeoutMs)
    timer.unref()
  })
}

async function inspect() {
  const result = await docker(['inspect', '--type', 'container', '--format', '{{json .State}}', config.containerName])
  if (result.timeout || result.overflow) return undefined
  if (result.code !== 0) return /no such (object|container)/i.test(result.stderr) ? { missing: true } : undefined
  try {
    const state = JSON.parse(result.stdout.trim())
    if (typeof state?.Running !== 'boolean') return undefined
    return { missing: false, running: state.Running, exitCode: typeof state.ExitCode === 'number' ? state.ExitCode : undefined }
  } catch { return undefined }
}

async function cleanup() {
  if (!created) return true
  await docker(['kill', config.containerName])
  for (let attempt = 0; attempt < 3; attempt++) {
    // Another trusted controller/CLI may already be removing this container.
    // A failed wait/kill during that race is not proof that it is still alive.
    const removed = await docker(['rm', '-f', config.containerName])
    if (removed.code === 0 && !removed.timeout && !removed.overflow) return true
    if ((await inspect())?.missing === true) return true
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}

async function finish(status, reason, exitCode) {
  if (finalizing) return
  finalizing = true
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
  // A create request can still reach the daemon after the parent times out.
  // Do not inspect/remove (or report quiescence) until that bounded request has
  // settled, otherwise a late successful create could become an orphan.
  await creationSettled
  const quiescent = await cleanup()
  if (dockerConfigDirectory !== undefined) await rm(dockerConfigDirectory, { recursive: true, force: true }).catch(() => undefined)
  complete = true
  send({ type: 'result', result: { status: quiescent ? status : 'unknown', quiescent, ...(exitCode === undefined ? {} : { exitCode }), stdout, stderr, ...(reason === undefined ? {} : { reason }) } })
  if (process.connected) process.disconnect()
}

async function begin() {
  const attached = await docker(['start', '--attach', config.containerName], {
    outputLimit: config.limits.maxOutputBytes,
    timeoutMs: Math.max(1, config.deadline - Date.now()),
  })
  stdout = attached.stdout
  stderr = attached.stderr
  if (finalizing) return
  if (attached.overflow) { await finish('failed', 'output-limit-exceeded'); return }
  if (attached.timeout) { await finish('unknown', 'docker-start-timeout'); return }
  const state = await inspect()
  if (state === undefined || state.missing || state.running) { await finish('unknown', 'container-state-unconfirmed'); return }
  await finish(state.exitCode === 0 ? 'succeeded' : 'failed', state.exitCode === 0 ? undefined : 'container-exited-nonzero', state.exitCode)
}

function valid(input) {
  return input && NAME.test(input.containerName) && IMAGE.test(input.image)
    && typeof input.dockerPath === 'string' && input.dockerPath.startsWith('/')
    && typeof input.workspacePath === 'string' && input.workspacePath.startsWith('/') && !/[\p{Cc},]/u.test(input.workspacePath)
    && typeof input.command === 'string' && Number.isSafeInteger(input.deadline)
    && input.limits && Object.values(input.limits).every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)
}

async function configure(next) {
  if (config !== undefined || !valid(next)) { send({ type: 'error', reason: 'invalid-supervisor-config' }); return }
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || typeof process.getgid !== 'function' || process.getuid() === 0) { send({ type: 'error', reason: 'non-root-linux-host-required' }); return }
  config = next
  try {
    dockerConfigDirectory = await mkdtemp(join(tmpdir(), 'dsh-isolation-docker-'))
    await chmod(dockerConfigDirectory, 0o700)
  } catch {
    await finish('failed', 'docker-config-directory-unavailable')
    return
  }
  if (finalizing) {
    await rm(dockerConfigDirectory, { recursive: true, force: true }).catch(() => undefined)
    return
  }
  const remaining = config.deadline - Date.now()
  if (remaining <= 0) { await finish('timed-out', 'deadline-expired-before-create'); return }
  deadlineTimer = setTimeout(() => { void finish('timed-out', 'deadline-expired') }, remaining)
  deadlineTimer.unref()
  const memory = `${Math.floor(config.limits.memoryMiB)}m`
  const tmpfsMiB = Math.max(1, Math.min(64, Math.floor(config.limits.memoryMiB / 4)))
  let markCreationSettled
  creationSettled = new Promise(resolve => { markCreationSettled = resolve })
  // Treat an in-flight create as owned. cleanup() will inspect the unique name
  // after the bounded CLI operation settles, whether create succeeded or not.
  created = true
  const createdResult = await docker([
    'create', '--pull', 'never', '--name', config.containerName, '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', `${process.getuid()}:${process.getgid()}`,
    '--pids-limit', String(Math.floor(config.limits.pidsLimit)), '--memory', memory, '--memory-swap', memory,
    '--cpus', String(config.limits.cpus), '--tmpfs', `/tmp:rw,nosuid,nodev,size=${tmpfsMiB}m`,
    '--mount', `type=bind,src=${config.workspacePath},dst=/workspace,readonly=false`, '--workdir', '/workspace',
    '--entrypoint', '/bin/sh', config.image, '-c', config.command,
  ])
  markCreationSettled()
  if (finalizing) return
  if (createdResult.code !== 0 || createdResult.timeout || createdResult.overflow) {
    await finish('failed', createdResult.timeout ? 'docker-create-timeout' : 'docker-create-failed')
    return
  }
  if (!process.connected) { await finish('unknown', 'parent-disconnected-before-authorization'); return }
  send({ type: 'ready' })
}

process.on('message', message => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'configure') void configure(message.config)
  else if (message.type === 'start' && config !== undefined && !finalizing && !started) { started = true; void begin() }
  else if (message.type === 'cancel' && config !== undefined) void finish('cancelled', typeof message.reason === 'string' ? message.reason : 'cancelled')
})
process.on('disconnect', () => { if (config !== undefined && !complete) void finish('unknown', 'parent-ipc-disconnected') })
