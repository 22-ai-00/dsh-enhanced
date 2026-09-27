import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const PACKAGE = '@deepseek-ai/dsh'
const REGISTRY = 'https://registry.npmjs.org/'
const MAX_OUTPUT = 1024 * 1024
const MAX_RECEIPT = 32 * 1024 * 1024
const MAX_ENTRIES = 150_000
const NPM_TIMEOUT = 8 * 60_000
const LOCK_TIMEOUT = 10 * 60_000

export interface ManagedHostRuntime {
  version: string
  root: string
  dshPath: string
  binDirectory: string
  integrity: string
  receiptDigest: string
}

export interface ManagedHostCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface ManagedHostRuntimePorts {
  /** Injectable npm transport for deterministic fixtures. The dsh executable is always run for real. */
  runNpm?: (args: readonly string[], options: { cwd: string; signal: AbortSignal; timeoutMs: number }) => Promise<ManagedHostCommandResult>
}

interface InventoryEntry {
  path: string
  type: 'directory' | 'file' | 'link'
  mode: number
  sha256?: string
  target?: string
}

interface RuntimeReceipt {
  schemaVersion: 1
  version: string
  integrity: string
  tarball: string
  entries: InventoryEntry[]
}

interface Metadata { version: string; integrity: string; tarball: string }

function fail(message: string): never { throw new Error(`Managed DSH runtime: ${message}`) }
function sha256(input: string | Buffer): string { return createHash('sha256').update(input).digest('hex') }
function inside(base: string, path: string): boolean {
  const part = relative(base, path)
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}
function isVersion(version: string): boolean {
  const match = /^0\.1\.5(?:-rc\.([0-9]{1,6}))?$/u.exec(version)
  return match !== null && (match[1] === undefined || Number(match[1]) >= 3)
}
function validVersion(version: string): string {
  if (!isVersion(version)) fail(`unsupported DSH version ${JSON.stringify(version)}; validated range is 0.1.5-rc.3 through 0.1.5`)
  return version
}
function validIntegrity(integrity: string): boolean {
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity)) return false
  const digest = integrity.slice('sha512-'.length)
  return Buffer.from(digest, 'base64').length === 64
    && Buffer.from(digest, 'base64').toString('base64') === digest
}

async function canonicalRoot(root: string, create: boolean): Promise<string> {
  if (!isAbsolute(root) || resolve(root) !== root) fail('cache root must be an absolute canonical path')
  if (create) await mkdir(root, { recursive: true, mode: 0o700 })
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) fail('cache root is not a real directory')
  if (process.getuid !== undefined && info.uid !== process.getuid()) fail('cache root is not owned by the current user')
  if ((info.mode & 0o077) !== 0) fail('cache root must be private (mode 0700)')
  if (await realpath(root) !== root) fail('cache root contains a symlink or a noncanonical path')
  return root
}

async function runBounded(command: string, args: readonly string[], options: { cwd: string; signal: AbortSignal; timeoutMs: number; maxOutput?: number }): Promise<ManagedHostCommandResult> {
  const maxOutput = options.maxOutput ?? MAX_OUTPUT
  if (options.signal.aborted) fail('operation cancelled')
  return await new Promise<ManagedHostCommandResult>((resolvePromise, reject) => {
    const child = spawn(command, [...args], { cwd: options.cwd, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let ended = false
    let reason: string | undefined
    const kill = (why: string) => {
      if (reason === undefined) reason = why
      if (child.pid !== undefined && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      } else child.kill('SIGKILL')
    }
    const timer = setTimeout(() => kill(`timed out after ${options.timeoutMs} ms`), options.timeoutMs)
    const aborted = () => kill('cancelled')
    options.signal.addEventListener('abort', aborted, { once: true })
    const append = (which: 'stdout' | 'stderr', chunk: Buffer) => {
      if (reason !== undefined) return
      if (which === 'stdout') stdout += chunk.toString('utf8')
      else stderr += chunk.toString('utf8')
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxOutput) {
        stdout = stdout.slice(0, maxOutput)
        stderr = stderr.slice(0, maxOutput)
        kill(`output exceeded ${maxOutput} bytes`)
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk))
    const finish = (error?: Error, code?: number | null) => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      options.signal.removeEventListener('abort', aborted)
      if (error !== undefined) reject(error)
      else if (reason !== undefined) reject(new Error(`Managed DSH runtime: process ${basename(command)} ${reason}`))
      else resolvePromise({ exitCode: code ?? -1, stdout, stderr })
    }
    child.on('error', error => finish(new Error(`Managed DSH runtime: cannot start ${basename(command)} (${error.message})`)))
    child.on('close', code => finish(undefined, code))
  })
}

async function npmCommand(args: readonly string[], cwd: string, signal: AbortSignal, ports: ManagedHostRuntimePorts): Promise<ManagedHostCommandResult> {
  const result = await (ports.runNpm ?? ((cmdArgs, opts) => runBounded('npm', cmdArgs, opts)))(args, { cwd, signal, timeoutMs: NPM_TIMEOUT })
  if (result.exitCode !== 0) {
    // npm diagnostics can echo auth configuration. Report a stable error code, never raw output.
    const code = /(?:^|\n)npm (?:ERR!|error) code ([A-Z][A-Z0-9_]*)/u.exec(result.stderr)?.[1]
    fail(`npm ${args[0] ?? 'command'} failed (exit ${result.exitCode}${code === undefined ? '' : `, ${code}`})`)
  }
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_OUTPUT) fail('npm output exceeded limit')
  return result
}

async function resolveMetadata(selector: string, root: string, signal: AbortSignal, ports: ManagedHostRuntimePorts): Promise<Metadata> {
  if (selector !== 'latest') validVersion(selector)
  const response = await npmCommand(['view', `${PACKAGE}@${selector}`, 'version', 'dist.integrity', 'dist.tarball', '--json', '--prefer-online', `--registry=${REGISTRY}`], root, signal, ports)
  let object: unknown
  try { object = JSON.parse(response.stdout) } catch { fail('npm view did not return valid JSON') }
  if (object === null || typeof object !== 'object' || Array.isArray(object)) fail('npm view returned unexpected metadata')
  const data = object as Record<string, unknown>
  const version = data.version
  const integrity = data['dist.integrity']
  const tarball = data['dist.tarball']
  if (typeof version !== 'string' || typeof integrity !== 'string' || typeof tarball !== 'string') fail('npm metadata is incomplete')
  validVersion(version)
  if (selector !== 'latest' && version !== selector) fail('npm resolved a different exact version')
  if (!validIntegrity(integrity)) fail('npm metadata lacks a valid SHA-512 integrity value')
  const expectedTarball = `${REGISTRY}@deepseek-ai/dsh/-/dsh-${version}.tgz`
  if (tarball !== expectedTarball) fail('npm metadata points outside the official DSH tarball')
  return { version, integrity, tarball }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function inventory(runtimeRoot: string): Promise<InventoryEntry[]> {
  const entries: InventoryEntry[] = []
  async function walk(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name)
      const rel = relative(runtimeRoot, path).split(sep).join('/')
      if (rel === 'receipt.json') continue
      if (entries.length >= MAX_ENTRIES) fail('runtime inventory exceeds limit')
      const info = await lstat(path)
      const mode = info.mode & 0o777
      if (info.isDirectory()) {
        entries.push({ path: rel, type: 'directory', mode })
        await walk(path)
      } else if (info.isFile()) {
        entries.push({ path: rel, type: 'file', mode, sha256: await sha256File(path) })
      } else if (info.isSymbolicLink()) {
        const link = await readlink(path)
        if (isAbsolute(link) || !inside(runtimeRoot, resolve(dirname(path), link))) fail(`symlink escapes runtime: ${rel}`)
        const destination = await realpath(path)
        if (!inside(runtimeRoot, destination)) fail(`symlink escapes runtime: ${rel}`)
        entries.push({ path: rel, type: 'link', mode, target: link })
      } else fail(`unsupported runtime file type: ${rel}`)
    }
  }
  await walk(runtimeRoot)
  return entries
}

async function parseJsonFile(path: string, maxBytes = MAX_RECEIPT): Promise<Record<string, unknown>> {
  const file = await lstat(path)
  if (!file.isFile() || file.isSymbolicLink() || file.size > maxBytes) fail(`invalid ${basename(path)}`)
  let parsed: unknown
  try { parsed = JSON.parse(await readFile(path, 'utf8')) } catch { fail(`invalid JSON in ${basename(path)}`) }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail(`invalid ${basename(path)}`)
  return parsed as Record<string, unknown>
}

async function verifyPackage(runtimeRoot: string, expected: Metadata, signal: AbortSignal): Promise<string> {
  const lock = await parseJsonFile(join(runtimeRoot, 'package-lock.json'))
  const packages = lock.packages
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) fail('package-lock lacks packages')
  const lockedRoot = (packages as Record<string, unknown>)['']
  if (lockedRoot === null || typeof lockedRoot !== 'object' || Array.isArray(lockedRoot)) fail('package-lock lacks root package')
  const lockedDependencies = (lockedRoot as Record<string, unknown>).dependencies
  if (lockedDependencies === null || typeof lockedDependencies !== 'object' || Array.isArray(lockedDependencies)
    || (lockedDependencies as Record<string, unknown>)[PACKAGE] !== expected.version) fail('package-lock root does not pin exact DSH version')
  const resolved = (packages as Record<string, unknown>)['node_modules/@deepseek-ai/dsh']
  if (resolved === null || typeof resolved !== 'object' || Array.isArray(resolved)) fail('package-lock lacks DSH')
  const entry = resolved as Record<string, unknown>
  if (entry.version !== expected.version || entry.integrity !== expected.integrity || entry.resolved !== expected.tarball) fail('package-lock DSH resolution differs from npm metadata')
  const rootManifest = await parseJsonFile(join(runtimeRoot, 'package.json'))
  const dependencies = rootManifest.dependencies
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)
    || (dependencies as Record<string, unknown>)[PACKAGE] !== expected.version) fail('runtime manifest does not pin exact DSH version')
  const packageRoot = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh')
  const manifest = await parseJsonFile(join(packageRoot, 'package.json'))
  if (manifest.name !== PACKAGE || manifest.version !== expected.version) fail('installed DSH package manifest differs from selected version')
  const bin = manifest.bin
  const binFile = typeof bin === 'object' && bin !== null && !Array.isArray(bin) ? (bin as Record<string, unknown>).dsh : undefined
  if (typeof binFile !== 'string' || binFile.length === 0 || isAbsolute(binFile) || !inside(packageRoot, resolve(packageRoot, binFile))) fail('installed DSH package has invalid bin metadata')
  const dshPath = join(runtimeRoot, 'node_modules', '.bin', 'dsh')
  const binInfo = await lstat(dshPath)
  if (!binInfo.isSymbolicLink() && !binInfo.isFile()) fail('installed DSH bin is missing')
  if (await realpath(dshPath) !== await realpath(resolve(packageRoot, binFile))) fail('installed DSH bin does not match its manifest')
  if ((await stat(dshPath)).mode & 0o111) {
    const version = await runBounded(dshPath, ['--version'], { cwd: runtimeRoot, signal, timeoutMs: 20_000, maxOutput: 4096 })
    if (version.exitCode !== 0 || version.stdout.trim() !== expected.version) fail('installed DSH --version differs from selected version')
  } else fail('installed DSH bin is not executable')
  return dshPath
}

async function checkReceipt(root: string, version: string, signal: AbortSignal): Promise<ManagedHostRuntime> {
  const runtimeRoot = join(root, version)
  const info = await lstat(runtimeRoot)
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`runtime ${version} is not a real directory`)
  if (process.getuid !== undefined && info.uid !== process.getuid()) fail(`runtime ${version} is not owned by the current user`)
  if ((info.mode & 0o077) !== 0) fail(`runtime ${version} is not private`)
  const receiptPath = join(runtimeRoot, 'receipt.json')
  const receipt = await parseJsonFile(receiptPath) as unknown as RuntimeReceipt
  if (receipt.schemaVersion !== 1 || receipt.version !== version || typeof receipt.integrity !== 'string'
    || typeof receipt.tarball !== 'string' || !Array.isArray(receipt.entries)) fail('runtime receipt is invalid')
  const expected: Metadata = { version, integrity: receipt.integrity, tarball: receipt.tarball }
  if (!validIntegrity(expected.integrity)
    || expected.tarball !== `${REGISTRY}@deepseek-ai/dsh/-/dsh-${version}.tgz`) fail('runtime receipt metadata is invalid')
  const actual = await inventory(runtimeRoot)
  if (JSON.stringify(actual) !== JSON.stringify(receipt.entries)) fail(`runtime ${version} file inventory changed`)
  const dshPath = await verifyPackage(runtimeRoot, expected, signal)
  const receiptDigest = sha256(JSON.stringify(receipt))
  return { version, root: runtimeRoot, dshPath, binDirectory: dirname(dshPath), integrity: expected.integrity, receiptDigest }
}

async function acquireLock(root: string, signal: AbortSignal): Promise<() => Promise<void>> {
  const lock = join(root, '.prepare.lock')
  const token = randomUUID()
  const deadline = Date.now() + LOCK_TIMEOUT
  for (;;) {
    if (signal.aborted) fail('operation cancelled while waiting for runtime lock')
    let created = false
    try {
      await mkdir(lock, { mode: 0o700 })
      created = true
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 })
      return async () => {
        try {
          const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as { token?: string }
          if (owner.token === token) await rm(lock, { recursive: true, force: true })
        } catch { /* another owner or damaged lock: never remove it */ }
      }
    } catch (error) {
      if (created) {
        await rm(lock, { recursive: true, force: true })
        throw error
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const age = Date.now() - (await stat(lock)).mtimeMs
      if (age > 60_000) {
        try {
          const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as { pid?: number }
          if (typeof owner.pid === 'number' && Number.isInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0) } catch (err) {
              if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
                const stale = join(root, `.stale-${randomUUID()}`)
                await rename(lock, stale)
                await rm(stale, { recursive: true, force: true })
                continue
              }
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            const stale = join(root, `.stale-${randomUUID()}`)
            try {
              await rename(lock, stale)
              await rm(stale, { recursive: true, force: true })
              continue
            } catch { /* another process may have acquired the lock */ }
          }
        }
      }
      if (Date.now() >= deadline) fail('timed out waiting for private runtime lock')
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); done() }, 100)
        const abort = () => { clearTimeout(timer); reject(new Error('Managed DSH runtime: operation cancelled')) }
        signal.addEventListener('abort', abort, { once: true })
      })
    }
  }
}

/** Read and independently verify a previously prepared exact version without contacting npm. */
export async function readManagedHostRuntime(input: { root: string; version: string; signal?: AbortSignal }): Promise<ManagedHostRuntime> {
  const root = await canonicalRoot(input.root, false)
  const version = validVersion(input.version)
  return await checkReceipt(root, version, input.signal ?? new AbortController().signal)
}

/** Resolve once from the official npm registry, then install exact DSH into an owner-private version directory. */
export async function prepareManagedHostRuntime(input: { root: string; selector?: 'latest' | string; signal?: AbortSignal }, ports: ManagedHostRuntimePorts = {}): Promise<ManagedHostRuntime> {
  const root = await canonicalRoot(input.root, true)
  const signal = input.signal ?? new AbortController().signal
  const release = await acquireLock(root, signal)
  try {
    const metadata = await resolveMetadata(input.selector ?? 'latest', root, signal, ports)
    const runtimeRoot = join(root, metadata.version)
    try {
      await lstat(runtimeRoot)
      const existing = await checkReceipt(root, metadata.version, signal)
      if (existing.integrity !== metadata.integrity) fail('cached runtime integrity differs from current registry metadata')
      return existing
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const stage = join(root, `.stage-${metadata.version}-${randomUUID()}`)
    await mkdir(stage, { mode: 0o700 })
    try {
      await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'dsh-enhanced-managed-host', private: true, version: '0.0.0', dependencies: { [PACKAGE]: metadata.version } }) + '\n', { flag: 'wx', mode: 0o600 })
      await npmCommand(['install', '--prefix', stage, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=true', '--save-exact', `--registry=${REGISTRY}`], stage, signal, ports)
      // Check links and package metadata before executing any installed code.
      const entries = await inventory(stage)
      await verifyPackage(stage, metadata, signal)
      const receipt: RuntimeReceipt = { schemaVersion: 1, ...metadata, entries }
      await writeFile(join(stage, 'receipt.json'), JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 })
      await chmod(stage, 0o700)
      await rename(stage, runtimeRoot)
      return await checkReceipt(root, metadata.version, signal)
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  } finally {
    await release()
  }
}
