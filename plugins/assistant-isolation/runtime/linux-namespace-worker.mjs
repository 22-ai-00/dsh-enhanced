import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, constants, fstatSync, readSync, writeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statfsSync, writeFileSync } from 'node:fs'
import { Socket } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TMPFS_MAGIC = 0x01021994
const CONTROL = /[\p{Cc}]/u
const MAX_PROTOCOL = 1_400_000
const FILTER_COMPILER = fileURLToPath(new URL('./linux-seccomp.py', import.meta.url))
const say = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const fail = message => { throw new Error(`linux namespace worker: ${message}`) }
let buffer = ''
let ended = false
let gate
let gateClosed = false
let finished = false
let revoked = false
let watchdog
let archiveInput
let binaryOutput
function revoke() {
  if (finished || revoked) return
  revoked = true
  archiveInput?.destroy()
  binaryOutput?.destroy()
  if (gate?.pid && !gateClosed) {
    gate.stdio[3]?.destroy()
    try { process.kill(-gate.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    gate.kill('SIGKILL')
  }
}
function closeControl() {
  ended = true
  revoke()
  while (waiters.length) waiters.shift()(undefined)
}
const lines = []
const waiters = []
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  if (buffer.length > MAX_PROTOCOL) { fail('protocol exceeds bound') }
  for (;;) {
    const end = buffer.indexOf('\n')
    if (end < 0) break
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    const waiter = waiters.shift()
    if (waiter) waiter(line)
    else lines.push(line)
  }
})
process.stdin.on('end', closeControl)
process.stdin.on('error', closeControl)
process.stdout.on('error', () => { closeControl(); process.stdin.destroy() })
function line() {
  if (lines.length) return Promise.resolve(lines.shift())
  if (ended) return Promise.resolve(undefined)
  return new Promise(resolve => waiters.push(resolve))
}

function ownedDirectory(path) {
  if (realpathSync(path) !== path) fail('directory changed')
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) fail('unsafe directory')
}
function tmpfs(path, bytes, inodes, noexec) {
  mkdirSync(path, { mode: 0o700 })
  ownedDirectory(path)
  const opts = `size=${bytes},nr_inodes=${inodes},mode=0700,nosuid,nodev${noexec ? ',noexec' : ''}`
  const mounted = spawnSync('/usr/bin/mount', ['-t', 'tmpfs', '-o', opts, 'tmpfs', path], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, encoding: 'utf8', timeout: 5_000,
  })
  if (mounted.status !== 0 || mounted.error) fail('bounded tmpfs mount failed')
  const observed = statfsSync(path)
  if (observed.type !== TMPFS_MAGIC || observed.bsize * observed.blocks !== bytes || observed.files !== inodes) {
    fail('tmpfs capacity differs')
  }
}
function mountPoints(root) {
  const decoded = value => value.replace(/\\([0-7]{3})/gu, (_, code) => String.fromCharCode(Number.parseInt(code, 8)))
  return readFileSync('/proc/self/mountinfo', 'utf8').trimEnd().split('\n').map(line => {
    const fields = line.split(' ')
    return { path: decoded(fields[4]), options: fields[5].split(',') }
  }).filter(entry => entry.path === root || entry.path.startsWith(root + '/'))
}
function pinnedReadOnly(source, target) {
  mkdirSync(target, { mode: 0o700 })
  ownedDirectory(target)
  const bind = spawnSync('/usr/bin/mount', ['--rbind', source, target], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, encoding: 'utf8', timeout: 5_000,
  })
  if (bind.status !== 0 || bind.error) fail('read-only runtime bind failed')
  const points = mountPoints(target).sort((a, b) => b.path.length - a.path.length)
  if (points.length < 1 || !points.some(point => point.path === target)) fail('runtime mount missing')
  for (const point of points) {
    const readonly = spawnSync('/usr/bin/mount', ['-o', 'remount,bind,ro', point.path], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, encoding: 'utf8', timeout: 5_000,
    })
    if (readonly.status !== 0 || readonly.error) fail('runtime mount could not be locked read-only')
  }
  if (mountPoints(target).some(point => !point.options.includes('ro'))) fail('runtime mount is writable')
}
function compiledFilter(jobPath, profile) {
  const output = spawnSync('/usr/bin/python3', ['-I', '-S', FILTER_COMPILER, profile], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, timeout: 10_000, maxBuffer: 65_536,
  })
  const bytes = output.stdout
  if (output.status !== 0 || output.error || !Buffer.isBuffer(bytes)
    || bytes.length < 8 || bytes.length > 65_536 || bytes.length % 8 !== 0) fail('fixed seccomp filter unavailable')
  const path = join(jobPath, 'seccomp.bpf')
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid()
    || (info.mode & 0o077) !== 0 || info.size !== bytes.length) fail('fixed seccomp filter changed')
  return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
}
function pathParts(path) {
  if (typeof path !== 'string' || path.length < 1 || path.length > 4096 || isAbsolute(path)
    || path.includes('\\') || CONTROL.test(path)
    || path.split('/').some(part => part.length === 0 || part === '.' || part === '..')) fail('unsafe path')
  return path.split('/')
}
function stage(workspace, file) {
  const parts = pathParts(file.path)
  let parent = workspace
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part)
    try { mkdirSync(parent, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    ownedDirectory(parent)
  }
  writeFileSync(join(parent, parts.at(-1)), file.content, { flag: 'wx', mode: 0o600 })
}
function processStartTicks(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ')
  const value = Number(fields[19])
  if (!Number.isSafeInteger(value) || value < 1) fail('candidate process identity unavailable')
  return value
}
function boundArtifact(workspace, path, byteLimit) {
  const parts = pathParts(path)
  let parent = workspace
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part)
    const info = lstatSync(parent)
    if (!info.isDirectory() || info.isSymbolicLink() || info.nlink < 2) fail('artifact parent is unsafe')
  }
  const target = join(parent, parts.at(-1))
  const info = lstatSync(target)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > byteLimit) fail('artifact is not a bounded regular file')
  const bytes = readFileSync(target)
  if (bytes.length !== info.size || bytes.includes(0)) fail('artifact changed or is binary')
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (!content.isWellFormed() || !Buffer.from(content).equals(bytes)) fail('artifact is not canonical UTF-8')
  const again = lstatSync(target)
  if (again.dev !== info.dev || again.ino !== info.ino || again.size !== info.size || again.mtimeMs !== info.mtimeMs) {
    fail('artifact changed during export')
  }
  return { path, content }
}

async function receiveArchive(config, target, assertLive) {
  const fd = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400)
  const hash = createHash('sha256')
  let count = 0
  archiveInput = new Socket({ fd: 4, readable: true, writable: false })
  try {
    for await (const bytes of archiveInput) {
      assertLive()
      count += bytes.length
      if (count > config.archive.size) fail('archive input exceeds declared length')
      hash.update(bytes)
      let offset = 0
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    }
    assertLive()
    if (count !== config.archive.size || hash.digest('hex') !== config.archive.sha256
      || fstatSync(fd).size !== count) fail('archive input length or digest mismatch')
  } finally { archiveInput.destroy(); closeSync(fd) }
}
function sameFile(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
    && after.isFile() && after.nlink === 1n
}
async function exportBinary(workspace, path, byteLimit, assertLive) {
  const parts = pathParts(path)
  let parent = workspace
  const parents = []
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part)
    const info = lstatSync(parent, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink()) fail('artifact parent is unsafe')
    parents.push({ path: parent, info })
  }
  const target = join(parent, parts.at(-1))
  const info = lstatSync(target, { bigint: true })
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > BigInt(byteLimit)) fail('artifact is not a bounded regular file')
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  const verify = () => {
    assertLive()
    if (!sameFile(info, fstatSync(fd, { bigint: true })) || !sameFile(info, lstatSync(target, { bigint: true }))) fail('artifact metadata changed')
    for (const parent of parents) {
      const again = lstatSync(parent.path, { bigint: true })
      if (!again.isDirectory() || again.isSymbolicLink() || again.dev !== parent.info.dev || again.ino !== parent.info.ino
        || again.mtimeNs !== parent.info.mtimeNs || again.ctimeNs !== parent.info.ctimeNs) fail('artifact parent changed')
    }
  }
  const hash = createHash('sha256')
  const bytes = Buffer.allocUnsafe(65536)
  let count = 0
  try {
    verify()
    for (;;) {
      verify()
      const read = readSync(fd, bytes, 0, Math.min(bytes.length, byteLimit - count + 1), null)
      if (read === 0) break
      count += read
      if (count > byteLimit || count > Number(info.size)) fail('artifact exceeds bound')
      hash.update(bytes.subarray(0, read))
      await new Promise((resolve, reject) => binaryOutput.write(bytes.subarray(0, read), error => error ? reject(error) : resolve()))
      verify()
    }
    verify()
    if (count !== Number(info.size)) fail('artifact length changed')
    return { path, size: count, sha256: hash.digest('hex') }
  } finally { closeSync(fd) }
}

function bwrapArgs(config, workspace, tmp, shm, pinned) {
  const args = ['--unshare-all', '--unshare-user', '--uid', '65534', '--gid', '65534',
    '--cap-drop', 'ALL', '--die-with-parent', '--new-session', '--clearenv',
    '--ro-bind', join(pinned, 'usr'), '/usr', '--ro-bind', join(pinned, 'lib'), '/lib',
    ...(existsSync('/lib64') ? ['--ro-bind', join(pinned, 'lib64'), '/lib64'] : []),
    '--symlink', 'usr/bin', '/bin', '--proc', '/proc', '--dev', '/dev',
    '--bind', shm, '/dev/shm', '--remount-ro', '/dev',
    '--ro-bind', join(config.jobPath, 'identity'), '/etc',
    '--dir', '/workspace', '--bind', workspace, '/workspace',
    '--dir', '/tmp', '--bind', tmp, '/tmp']
  if (config.schemaVersion === 2) args.push('--dir', '/input', '--ro-bind', join(config.jobPath, 'input', 'source.tar'), '/input/source.tar')
  if (config.readOnlyRoots.length > 0) args.push('--dir', '/runtime')
  for (let i = 0; i < config.readOnlyRoots.length; i++) {
    const root = config.readOnlyRoots[i]
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) fail('runtime root changed')
    args.push('--ro-bind', join(pinned, 'runtime', String(i)), `/runtime/${i}`)
  }
  args.push('--remount-ro', '/', '--chdir', '/workspace', '--setenv', 'HOME', '/workspace',
    '--setenv', 'TMPDIR', '/tmp', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'LANG', 'C',
    '--setenv', 'LC_ALL', 'C')
  if (config.profile === 'ordinary') args.push('--disable-userns')
  // Bwrap consumes fd 4 to install the fixed BPF policy. The candidate shell
  // closes that descriptor before replacing itself with the requested program.
  args.push('--seccomp', '4', '--', '/bin/sh', '-c', 'exec 4<&-; exec "$@"', 'dsh-seccomp-entry', ...config.argv)
  return args
}

async function main() {
  const payload = await line()
  if (payload === undefined) fail('request missing')
  const config = JSON.parse(payload)
  if (!config || ![1, 2].includes(config.schemaVersion) || !['ordinary', 'repository'].includes(config.profile)
    || !Number.isSafeInteger(config.workspaceBytes) || !Number.isSafeInteger(config.workspaceInodes)
    || !Number.isSafeInteger(config.tmpBytes) || !Number.isSafeInteger(config.tmpInodes)
    || !Number.isSafeInteger(config.deadline) || config.deadline <= Date.now() || config.deadline > Date.now() + 1_800_000
    || !Number.isSafeInteger(config.maxArtifactBytes) || config.maxArtifactBytes < 1 || config.maxArtifactBytes > (config.schemaVersion === 2 ? 33_554_432 : 1_048_576)
    || !Number.isSafeInteger(config.maxOutputBytes) || !Array.isArray(config.argv)
    || !Array.isArray(config.files) || !Array.isArray(config.artifacts) || !Array.isArray(config.readOnlyRoots)) fail('invalid request')
  const repository = config.schemaVersion === 2
  if (repository && (config.profile !== 'repository' || !config.archive || !Number.isSafeInteger(config.archive.size)
    || config.archive.size < 1 || config.archive.size > 67_108_864 || !/^[0-9a-f]{64}$/u.test(config.archive.sha256)
    || config.files.length !== 0)) fail('invalid repository request')
  if (config.workspaceBytes < 4096 || config.workspaceBytes > (repository ? 8 : 4) * 1024 ** 3 || config.workspaceBytes % 4096 !== 0
    || config.tmpBytes < 4096 || config.tmpBytes > (repository ? 4 : 2) * 1024 ** 3 || config.tmpBytes % 4096 !== 0
    || config.workspaceInodes < 16 || config.workspaceInodes > 1_000_000 || config.tmpInodes < 16 || config.tmpInodes > 1_000_000
    || config.maxOutputBytes < 1 || config.maxOutputBytes > 1_048_576 || config.artifacts.length > 128) fail('invalid resource bounds')
  const names = new Set()
  for (const file of config.files) {
    pathParts(file.path)
    if (names.has(file.path) || typeof file.content !== 'string' || !file.content.isWellFormed()) fail('invalid input file')
    names.add(file.path)
  }
  if ([...names].some(name => [...names].some(other => other !== name && other.startsWith(`${name}/`)))
    || config.files.reduce((bytes, file) => bytes + Buffer.byteLength(file.content), 0) > 1_048_576) fail('input files exceed bounds or collide')
  for (const path of config.artifacts) pathParts(path)
  if (new Set(config.artifacts).size !== config.artifacts.length) fail('duplicate artifacts')
  // This deadline belongs to the keeper, independently of the Host process.
  // Closing the Host control pipe also revokes the candidate's execution.
  watchdog = setTimeout(() => { closeControl(); process.stdin.destroy() }, Math.max(1, config.deadline - Date.now()))
  const assertLive = () => { if (revoked || ended || Date.now() >= config.deadline) fail('execution authority ended') }
  assertLive()
  ownedDirectory(config.jobPath)
  for (const source of ['/usr', '/lib', '/lib64']) {
    if (!existsSync(source)) continue
    const system = realpathSync(source)
    if (config.jobPath === system || config.jobPath.startsWith(system + '/')
      || system.startsWith(config.jobPath + '/')) fail('private state overlaps exposed system files')
  }
  const workspace = join(config.jobPath, 'workspace'), tmp = join(config.jobPath, 'tmp'), shm = join(config.jobPath, 'shm')
  tmpfs(workspace, config.workspaceBytes, config.workspaceInodes, false)
  tmpfs(tmp, config.tmpBytes, config.tmpInodes, !repository)
  tmpfs(shm, 1_048_576, 4096, true)
  if (repository) {
    const input = join(config.jobPath, 'input')
    tmpfs(input, 67_112_960, 16, true)
    await receiveArchive(config, join(input, 'source.tar'), assertLive)
    binaryOutput = new Socket({ fd: 5, readable: false, writable: true })
    binaryOutput.on('error', closeControl)
  }
  const identityDirectory = join(config.jobPath, 'identity')
  mkdirSync(identityDirectory, { mode: 0o755 })
  writeFileSync(join(identityDirectory, 'passwd'), 'nobody:x:65534:65534:Sandbox:/workspace:/bin/sh\n', { flag: 'wx', mode: 0o444 })
  writeFileSync(join(identityDirectory, 'group'), 'nobody:x:65534:\n', { flag: 'wx', mode: 0o444 })
  writeFileSync(join(identityDirectory, 'nsswitch.conf'), 'passwd: files\ngroup: files\nhosts: files\n', { flag: 'wx', mode: 0o444 })
  writeFileSync(join(identityDirectory, 'hosts'), '127.0.0.1 localhost\n::1 localhost\n', { flag: 'wx', mode: 0o444 })
  const pinned = join(config.jobPath, 'immutable')
  mkdirSync(pinned, { mode: 0o700 })
  pinnedReadOnly('/usr', join(pinned, 'usr'))
  pinnedReadOnly('/lib', join(pinned, 'lib'))
  if (existsSync('/lib64')) pinnedReadOnly('/lib64', join(pinned, 'lib64'))
  if (config.readOnlyRoots.length > 0) mkdirSync(join(pinned, 'runtime'), { mode: 0o700 })
  for (let i = 0; i < config.readOnlyRoots.length; i++) {
    const root = config.readOnlyRoots[i]
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) fail('runtime root changed')
    pinnedReadOnly(root, join(pinned, 'runtime', String(i)))
  }
  for (const file of config.files) stage(workspace, file)
  const args = bwrapArgs(config, workspace, tmp, shm, pinned)
  const filter = compiledFilter(config.jobPath, config.profile)
  // This trusted fixed shell waits on a private fd, then execs bwrap in the
  // same host PID. The Host can move that exact PID into a cgroup first.
  assertLive()
  try {
    gate = spawn('/bin/sh', ['-c', 'IFS= read -r gate <&3 || exit 125; [ "$gate" = START ] || exit 125; exec 3<&-; exec "$@"',
      'dsh-native-gate', '/usr/bin/bwrap', ...args], {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', filter], shell: false, detached: true,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    })
  } finally { closeSync(filter) }
  const gateExit = new Promise(resolve => {
    gate.once('error', error => { closeControl(); resolve({ code: null, signal: null, error: error.message }) })
    gate.once('close', (code, signal) => { gateClosed = true; resolve({ code, signal }) })
  })
  gate.stdio[3]?.on('error', closeControl)
  if (!gate.pid) fail('candidate gate did not start')
  assertLive()
  const identity = { pid: gate.pid, startTicks: processStartTicks(gate.pid) }
  say({ type: 'READY', ...identity })
  const authorization = await line()
  if (authorization !== 'START' || gateClosed || revoked || ended || Date.now() >= config.deadline) {
    gate.stdio[3].end()
    gate.kill('SIGKILL')
    fail('candidate start not authorized')
  }
  gate.stdio[3].end('START\n')
  let stdout = '', stderr = '', outputBytes = 0, exceeded = false
  const chunksOut = [], chunksErr = []
  const append = (which, chunk) => {
    outputBytes += chunk.length
    if (outputBytes > config.maxOutputBytes) {
      exceeded = true
      try { process.kill(-gate.pid, 'SIGKILL') } catch {}
      return
    }
    if (which === 'out') chunksOut.push(chunk)
    else chunksErr.push(chunk)
  }
  gate.stdout.on('data', chunk => append('out', chunk))
  gate.stderr.on('data', chunk => append('err', chunk))
  const exit = await gateExit
  const decode = chunks => {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }
    catch { return '' }
  }
  stdout = decode(chunksOut); stderr = decode(chunksErr)
  say({ type: 'EXIT', ...identity, ...exit, exceeded })
  if (await line() !== 'EXPORT') fail('external quiescence proof missing')
  assertLive()
  const artifacts = []
  let artifactBytes = 0
  if (!repository || !exceeded && exit.code === 0) {
    for (const path of config.artifacts) {
      assertLive()
      const file = repository
        ? await exportBinary(workspace, path, config.maxArtifactBytes - artifactBytes, assertLive)
        : boundArtifact(workspace, path, config.maxArtifactBytes)
      artifactBytes += repository ? file.size : Buffer.byteLength(file.content)
      if (artifactBytes > config.maxArtifactBytes) fail('artifact output exceeds bound')
      artifacts.push(file)
    }
  }
  if (repository) await new Promise((resolve, reject) => {
    binaryOutput.once('error', reject)
    binaryOutput.end(resolve)
  })
  assertLive()
  finished = true
  say({ type: 'RESULT', status: !exceeded && exit.code === 0 ? 'succeeded' : 'failed',
    exitCode: exit.code, stdout: exceeded ? '' : stdout, stderr: exceeded ? '' : stderr,
    artifacts, reason: exceeded ? 'candidate output exceeded bound' : exit.error })
}

main().catch(error => {
  revoke()
  try { say({ type: 'ERROR', reason: error instanceof Error ? error.message : 'worker failed' }) } catch {}
  process.exitCode = 1
}).finally(() => { clearTimeout(watchdog); process.stdin.destroy(); archiveInput?.destroy(); binaryOutput?.destroy() })
