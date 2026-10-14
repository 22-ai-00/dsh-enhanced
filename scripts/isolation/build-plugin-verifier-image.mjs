// Owner-only image build. Its temporary context has manifests, the lock,
// Dockerfile and the fixed verifier worker; no application source or secrets.
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { copyFile, lstat, mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const dockerfile = join(root, 'scripts/isolation/plugin-verifier.Dockerfile')
const source = join(root, 'plugins/assistant-verifier/src/plugin-behavior-runner.ts')
const imagePattern = /^sha256:[a-f0-9]{64}$/u
const options = { dockerPath: '/usr/bin/docker', socketPath: undefined, platform: process.arch === 'arm64' ? 'arm64' : 'amd64', sourceImage: '', tag: '', timeoutMs: 1_800_000 }
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index], value = process.argv[index + 1]
  if (value === undefined) throw new Error('missing argument value')
  if (flag === '--source-image') options.sourceImage = value
  else if (flag === '--docker-path') options.dockerPath = value
  else if (flag === '--socket-path') options.socketPath = value
  else if (flag === '--platform') options.platform = value
  else if (flag === '--tag') options.tag = value
  else if (flag === '--timeout-ms') options.timeoutMs = Number(value)
  else throw new Error('unknown argument: ' + flag)
}
if (!imagePattern.test(options.sourceImage) || !Number.isSafeInteger(options.timeoutMs)
  || options.timeoutMs < 60_000 || options.timeoutMs > 1_800_000
  || !['amd64', 'arm64'].includes(options.platform) || options.platform !== (process.arch === 'arm64' ? 'arm64' : 'amd64')
  || (process.platform === 'darwin' && options.socketPath === undefined)
  || (options.socketPath !== undefined && (typeof options.socketPath !== 'string' || !options.socketPath.startsWith('/')
    || resolve(options.socketPath) !== options.socketPath || !options.socketPath.endsWith('/.docker/run/docker.sock')))
  || options.tag && !/^[a-z0-9][a-z0-9._/-]{0,127}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/u.test(options.tag)) {
  throw new Error('source image ID, tag or build timeout invalid')
}
const dockerPath = await realpath(options.dockerPath)
const metadata = await lstat(dockerPath)
if (dockerPath !== resolve(options.dockerPath) || !metadata.isFile() || metadata.isSymbolicLink()
  || (metadata.mode & 0o111) === 0 || (metadata.mode & 0o022) !== 0
  || metadata.uid !== 0 && metadata.uid !== process.getuid?.()) throw new Error('unsafe Docker executable')
if (options.socketPath !== undefined) {
  if (await realpath(options.socketPath) !== options.socketPath) throw new Error('Docker socket is not canonical')
  const socket = await lstat(options.socketPath), parent = await lstat(dirname(options.socketPath))
  if (!socket.isSocket() || socket.uid !== process.getuid?.() || !parent.isDirectory()
    || parent.uid !== process.getuid?.() || parent.mode & 0o022) throw new Error('Docker socket is not owner-safe')
}
const temporary = await mkdtemp(join(tmpdir(), 'dsh-plugin-verifier-image-'))
const context = join(temporary, 'context')
const dockerConfig = join(temporary, 'docker-config')
const environment = { PATH: '/usr/bin:/bin', HOME: temporary, DOCKER_CONFIG: dockerConfig, DOCKER_BUILDKIT: '1' }
const dockerArgs = args => options.socketPath === undefined ? args
  : ['--config', dockerConfig, '-H', `unix://${options.socketPath}`, ...args]
const inventory = []
const temporarySourceTag = 'dsh-plugin-verifier-source:' + randomUUID().replaceAll('-', '')
let taggedSource = false
async function copy(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('unsafe image context file: ' + path)
  const name = relative(root, path)
  const target = join(context, name)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await copyFile(path, target)
  inventory.push(name)
}
async function command(args, collect = false) {
  const child = spawn(dockerPath, dockerArgs(args), { shell: false, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', error = '', bytes = 0, timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, options.timeoutMs)
  child.stdout.on('data', chunk => {
    bytes += chunk.length
    if (bytes > 8_192 && collect) child.kill('SIGKILL')
    else if (collect) output += chunk.toString('utf8')
    else process.stderr.write(chunk)
  })
  child.stderr.on('data', chunk => {
    error = (error + chunk.toString('utf8')).slice(-8_192)
    process.stderr.write(chunk)
  })
  const code = await new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('close', resolvePromise)
  }).finally(() => clearTimeout(timer))
  if (timedOut || code !== 0) throw new Error('Docker command failed: ' + args[0] + ' exit=' + code + ' ' + error.trim())
  return output.trim()
}
try {
  await mkdir(context, { mode: 0o700 })
  await mkdir(dockerConfig, { mode: 0o700 })
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (manifest.packageManager !== 'pnpm@11.7.0') throw new Error('unexpected root package manager')
  for (const path of [dockerfile, join(root, 'package.json'), join(root, 'pnpm-lock.yaml'), join(root, 'pnpm-workspace.yaml')]) await copy(path)
  await copy(join(root, 'scripts/isolation/plugin-observer-launcher.c'))
  for (const folder of ['plugins', 'packages']) {
    for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const path = join(root, folder, entry.name, 'package.json')
      try { await copy(path) } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }
  const raw = await readFile(source, 'utf8')
  function fixedAsset(name) {
    const begin = `/* DSH_PLUGIN_VERIFIER_${name}_START\n`
    const end = `\nDSH_PLUGIN_VERIFIER_${name}_END */`
    const first = raw.indexOf(begin)
    const last = raw.indexOf(end, first + begin.length)
    if (first < 0 || last < 0 || raw.indexOf(begin, first + 1) >= 0 || raw.indexOf(end, last + 1) >= 0)
      throw new Error(`fixed plugin ${name.toLowerCase()} markers invalid`)
    const content = raw.slice(first + begin.length, last) + '\n'
    if (Buffer.byteLength(content) > 32 * 1024) throw new Error(`fixed plugin ${name.toLowerCase()} too large`)
    return content
  }
  const worker = fixedAsset('WORKER')
  const candidate = fixedAsset('CANDIDATE')
  await writeFile(join(context, 'worker.mjs'), worker, { mode: 0o600 })
  await writeFile(join(context, 'candidate.mjs'), candidate, { mode: 0o600 })
  inventory.push('worker.mjs')
  inventory.push('candidate.mjs')
  const lockSha256 = createHash('sha256').update(await readFile(join(root, 'pnpm-lock.yaml'))).digest('hex')
  const tag = options.tag || 'dsh-plugin-verifier:' + lockSha256.slice(0, 16) + '-' + randomUUID().slice(0, 8)
  const platformSuffix = `/linux/${options.platform}`
  if (await command(['image', 'inspect', '--format', '{{.Id}}/{{.Os}}/{{.Architecture}}', options.sourceImage], true) !== options.sourceImage + platformSuffix)
    throw new Error('local source image content ID or platform differs')
  await command(['image', 'tag', options.sourceImage, temporarySourceTag])
  taggedSource = true
  if (await command(['image', 'inspect', '--format', '{{.Id}}/{{.Os}}/{{.Architecture}}', temporarySourceTag], true) !== options.sourceImage + platformSuffix)
    throw new Error('temporary source tag differs from approved ID')
  await command(['build', '--pull=false', '--platform', `linux/${options.platform}`, '--file', join(context, 'scripts/isolation/plugin-verifier.Dockerfile'),
    '--build-arg', 'SOURCE_IMAGE=' + temporarySourceTag, '--tag', tag, context])
  const inspected = await command(['image', 'inspect', '--format', '{{.Id}}/{{.Os}}/{{.Architecture}}', tag], true)
  const id = inspected.slice(0, -platformSuffix.length)
  if (inspected !== id + platformSuffix || !imagePattern.test(id)) throw new Error('Docker did not return an immutable image on the required Linux platform')
  process.stdout.write(JSON.stringify({ image: id, tag, sourceImage: options.sourceImage, lockSha256,
    workerSha256: createHash('sha256').update(worker).digest('hex'),
    candidateSha256: createHash('sha256').update(candidate).digest('hex'),
    launcherSourceSha256: createHash('sha256').update(await readFile(join(context, 'scripts/isolation/plugin-observer-launcher.c'))).digest('hex'),
    dockerfileSha256: createHash('sha256').update(await readFile(join(context, 'scripts/isolation/plugin-verifier.Dockerfile'))).digest('hex'),
    contextFiles: inventory.sort() }) + '\n')
} finally {
  if (taggedSource) {
    try { await command(['image', 'rm', temporarySourceTag]) } catch { /* Build failure is already reported. */ }
  }
  await rm(temporary, { recursive: true, force: true })
}
