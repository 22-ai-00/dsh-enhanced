// Build the owner-controlled source-check image from an intentionally tiny
// context. The context contains manifests and the lock only: never source,
// .npmrc, a host pnpm store, credentials, or Docker configuration.
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { copyFile, lstat, mkdtemp, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const dockerfile = join(root, 'scripts', 'isolation', 'source-builder.Dockerfile')
const baseImage = 'node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9'
const packageManager = 'pnpm@11.7.0'
const maximumTimeoutMs = 1_800_000

function parseArguments(argv) {
  const value = { dockerPath: '/usr/bin/docker', timeoutMs: 1_800_000, tag: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = argv[index + 1]
    if (flag === '--docker-path') { value.dockerPath = next; index += 1 }
    else if (flag === '--timeout-ms') { value.timeoutMs = Number(next); index += 1 }
    else if (flag === '--tag') { value.tag = next; index += 1 }
    else throw new Error(`unknown argument: ${flag}`)
  }
  if (typeof value.dockerPath !== 'string' || !value.dockerPath.startsWith('/') || value.dockerPath.includes('\0')
    || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 60_000 || value.timeoutMs > maximumTimeoutMs
    || (value.tag !== undefined && (typeof value.tag !== 'string' || !/^[a-z0-9][a-z0-9._/-]{0,127}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/u.test(value.tag)))) {
    throw new Error('invalid docker path, timeout, or local image tag')
  }
  return value
}

async function regularFile(path, label) {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4 * 1024 * 1024) throw new Error(`${label} must be a bounded regular file`)
}

async function trustedDockerPath(path) {
  const canonical = await realpath(path)
  const metadata = await lstat(canonical)
  const parent = await lstat(dirname(canonical))
  const uid = process.getuid?.()
  if (canonical !== resolve(path) || !metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111) === 0
    || (metadata.mode & 0o022) !== 0 || !parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o002) !== 0
    || (uid !== undefined && metadata.uid !== 0 && metadata.uid !== uid)) {
    throw new Error('docker client must be a canonical owner- or root-owned non-writable executable')
  }
  return canonical
}

async function copyContextFile(context, source, inventory) {
  await regularFile(source, relative(root, source))
  const target = join(context, relative(root, source))
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await copyFile(source, target)
  inventory.push(relative(root, source))
}

async function workspaceManifests() {
  const result = []
  for (const folder of ['plugins', 'packages']) {
    for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const manifest = join(root, folder, entry.name, 'package.json')
      try { await regularFile(manifest, `${folder}/${entry.name}/package.json`) } catch (error) {
        if (error && typeof error === 'object' && error.code === 'ENOENT') continue
        throw error
      }
      result.push(manifest)
    }
  }
  return result.sort()
}

async function run(command, args, timeoutMs, signal) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false, env: { PATH: '/usr/bin:/bin', HOME: temporaryRoot, DOCKER_CONFIG: dockerConfig } })
    let stderr = ''; let settled = false; let timedOut = false
    const abort = () => { child.kill('SIGKILL') }
    const finish = (callback) => value => {
      if (!settled) { settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); callback(value) }
    }
    const timer = setTimeout(() => { timedOut = true; abort() }, timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stderr.on('data', chunk => {
      const text = chunk.toString('utf8')
      stderr = (stderr + text).slice(-8_192)
      process.stderr.write(chunk)
    })
    child.once('error', finish(error => reject(error)))
    child.once('close', finish(code => timedOut ? reject(new Error(`docker build exceeded ${timeoutMs}ms`))
      : signal.aborted ? reject(signal.reason ?? new Error('docker build aborted'))
        : code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}: ${stderr.trimEnd()}`))))
  })
}

async function imageId(dockerPath, tag, timeoutMs, signal) {
  let output = ''
  await new Promise((resolvePromise, reject) => {
    const child = spawn(dockerPath, ['image', 'inspect', '--format', '{{.Id}}', tag], { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: { PATH: '/usr/bin:/bin', HOME: temporaryRoot, DOCKER_CONFIG: dockerConfig } })
    let stderr = ''; let settled = false; let timedOut = false; let outputBytes = 0
    const abort = () => { child.kill('SIGKILL') }
    const finish = callback => value => {
      if (!settled) { settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); callback(value) }
    }
    const timer = setTimeout(() => { timedOut = true; abort() }, Math.min(timeoutMs, 30_000))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length
      if (outputBytes > 4_096) { timedOut = true; abort(); return }
      output += chunk.toString('utf8')
    })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4_096) })
    child.once('error', finish(reject))
    child.once('close', finish(code => timedOut ? reject(new Error('docker image inspect exceeded its deadline'))
      : signal.aborted ? reject(signal.reason ?? new Error('docker image inspect aborted'))
        : code === 0 ? resolvePromise() : reject(new Error(`docker image inspect exited ${code}: ${stderr.trimEnd()}`))))
  })
  if (!/^sha256:[a-f0-9]{64}$/u.test(output.trim())) throw new Error('docker did not return an immutable image content ID')
  return output.trim()
}

const options = parseArguments(process.argv.slice(2))
const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-source-builder-'))
const context = join(temporaryRoot, 'context')
const dockerConfig = join(temporaryRoot, 'docker-config')
const abort = new AbortController()
const abortBuild = () => abort.abort(new Error('source image build interrupted'))
process.once('SIGINT', abortBuild)
process.once('SIGTERM', abortBuild)
try {
  await mkdir(context, { mode: 0o700 })
  await mkdir(dockerConfig, { mode: 0o700 })
  const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (rootManifest.packageManager !== packageManager) throw new Error(`root packageManager must be exactly ${packageManager}`)
  const inventory = []
  for (const path of [dockerfile, join(root, 'package.json'), join(root, 'pnpm-lock.yaml'), join(root, 'pnpm-workspace.yaml'), ...await workspaceManifests()]) {
    await copyContextFile(context, path, inventory)
  }
  const lock = await readFile(join(context, 'pnpm-lock.yaml'))
  const lockSha256 = createHash('sha256').update(lock).digest('hex')
  const tag = options.tag ?? `dsh-source-builder:${lockSha256.slice(0, 16)}-${randomUUID().slice(0, 8)}`
  const dockerPath = await trustedDockerPath(options.dockerPath)
  await run(dockerPath, ['build', '--pull=false', '--file', join(context, 'scripts', 'isolation', 'source-builder.Dockerfile'),
    '--build-arg', `BASE_IMAGE=${baseImage}`, '--tag', tag, context], options.timeoutMs, abort.signal)
  const id = await imageId(dockerPath, tag, options.timeoutMs, abort.signal)
  process.stdout.write(JSON.stringify({ image: id, tag, baseImage, packageManager, lockSha256, contextFiles: inventory.sort() }) + '\n')
} finally {
  // The context is the only temporary copy of repository metadata and is
  // removed on success, spawn failure, timeout, or external interruption.
  await rm(temporaryRoot, { recursive: true, force: true })
  process.removeListener('SIGINT', abortBuild)
  process.removeListener('SIGTERM', abortBuild)
}
