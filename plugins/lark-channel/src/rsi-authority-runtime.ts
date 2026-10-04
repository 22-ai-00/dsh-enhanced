import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { rsiBuildResources as io } from './rsi-build.js'
import { version } from './version.js'

export interface Pin { path: string; sha256: string }
const PHASES = ['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'] as const
type Phase = typeof PHASES[number]
type Executable = 'approval' | 'release' | 'adoption' | 'observation' | 'qualification' | 'hostAuthority' | 'hostAttestor'
export interface RsiAuthorityRuntime {
  schemaVersion: 1
  packageVersion: string
  root: string
  node: Pin
  executables: Record<Executable, Pin>
  releaseAdapters: Record<Phase, Pin>
  processHelper: Pin
  observerClient: Pin
  catalogValidator: Pin
  catalogInterpreter: Pin
}
interface Entry { path: string; sha256: string; size: number; mode: number;
  sourcePath: string; sourceSha256: string; sourceSize: number; sourceMode: number }
interface Receipt extends RsiAuthorityRuntime { entries: Entry[]; digest: string }
interface Options { packageRoot?: string; nodePath?: string }
const EXECUTABLES: Record<Executable, string> = {
  approval: 'dsh-source-approval-authority.js', release: 'dsh-source-release-authority.js',
  adoption: 'dsh-source-adoption-authority.js', observation: 'dsh-task-observation-authority.js',
  qualification: 'dsh-live-qualification-authority.js', hostAuthority: 'dsh-systemd-host-authority.js',
  hostAttestor: 'dsh-systemd-host-attestor.js',
}
const MAX_ENTRIES = 512, MAX_FILE = 160_000_000, MAX_TOTAL = 256_000_000
const CONTRACT_PACKAGE = '@dsh-enhanced/assistant-growth-contract'
const CONTRACT_ROOT = `node_modules/${CONTRACT_PACKAGE}`
const RUNTIME_DIRECTORIES = ['bin', 'lib', 'node_modules', 'node_modules/@dsh-enhanced', CONTRACT_ROOT, `${CONTRACT_ROOT}/lib`]
function fail(message: string): never { throw new Error(`rsi authority runtime: ${message}`) }
function hash(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex') }
function exactPath(path: string): boolean { return isAbsolute(path) && resolve(path) === path
  && !path.includes('\0') && !path.includes('\r') && !path.includes('\n') }
function environment(home: string): NodeJS.ProcessEnv { return { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: home } }
function pin(root: string, path: string, sha256: string): Pin { return { path: join(root, path), sha256 } }
function result(root: string, entries: Entry[]): RsiAuthorityRuntime {
  const found = (path: string) => {
    const item = entries.find(entry => entry.path === path)
    if (!item) fail(`missing asset: ${path}`)
    return pin(root, path, item.sha256)
  }
  const executables = {} as Record<Executable, Pin>
  for (const [key, filename] of Object.entries(EXECUTABLES) as [Executable, string][]) executables[key] = found(`bin/${filename}`)
  const releaseAdapters = {} as Record<Phase, Pin>
  for (const phase of PHASES) releaseAdapters[phase] = found(`bin/dsh-local-release-${phase}.js`)
  return { schemaVersion: 1, packageVersion: version, root, node: found('node'), executables, releaseAdapters,
    processHelper: found('lib/adapter-process.js'), observerClient: found('lib/runtime-observer-protocol.js'),
    catalogValidator: found('lib/catalog.js'), catalogInterpreter: found('lib/catalog-interpreter.js') }
}
async function asset(path: string, maximum: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  const bytes = await io.readStable(path, maximum, false, true)
  signal.throwIfAborted()
  return bytes
}
async function sourceAssets(packageRoot: string, nodePath: string, signal: AbortSignal) {
  await io.directory(packageRoot, false)
  await io.directory(join(packageRoot, 'bin'), false)
  await io.directory(join(packageRoot, 'lib'), false)
  const packageBytes = await asset(join(packageRoot, 'package.json'), 65_536, signal)
  const manifest = JSON.parse(packageBytes.toString('utf8')) as {
    name?: string; version?: string; type?: string; dependencies?: Record<string, unknown>
  }
  if (manifest.name !== '@dsh-enhanced/plugin-control-plane' || manifest.version !== version || manifest.type !== 'module') fail('installed package identity differs')
  if (typeof manifest.dependencies?.[CONTRACT_PACKAGE] !== 'string') fail('installed shared contract is not declared')
  const libraries = (await readdir(join(packageRoot, 'lib'))).filter(name => name.endsWith('.js')).sort()
  if (!libraries.length || libraries.length + 19 > MAX_ENTRIES) fail('library entry bound exceeded')
  const names = new Map<string, string>([['package.json', join(packageRoot, 'package.json')], ['node', nodePath]])
  for (const name of libraries) names.set(`lib/${name}`, join(packageRoot, 'lib', name))
  for (const name of Object.values(EXECUTABLES)) names.set(`bin/${name}`, join(packageRoot, 'bin', name))
  for (const phase of PHASES) names.set(`bin/dsh-local-release-${phase}.js`, join(packageRoot, 'bin', 'dsh-local-release-adapter.js'))
  // Resolve through this package's manifest, but accept only its own dependency
  // edge or the adjacent edge in the same pnpm virtual-store node_modules.
  const resolvedContract = createRequire(join(packageRoot, 'package.json')).resolve(`${CONTRACT_PACKAGE}/package.json`)
  const contractRoot = dirname(await realpath(resolvedContract))
  const edges = [join(packageRoot, 'node_modules', CONTRACT_PACKAGE)]
  if (basename(dirname(packageRoot)) === '@dsh-enhanced' && basename(dirname(dirname(packageRoot))) === 'node_modules'
    && basename(dirname(dirname(dirname(dirname(packageRoot))))) === '.pnpm') {
    edges.push(join(dirname(packageRoot), 'assistant-growth-contract'))
  }
  const edgeRoots = await Promise.all(edges.map(async edge => realpath(edge).catch(() => undefined)))
  if (!edgeRoots.includes(contractRoot)) fail('installed shared contract resolved outside its dependency edge')
  await io.directory(contractRoot, false)
  await io.directory(join(contractRoot, 'lib'), false)
  const contractPackageBytes = await asset(join(contractRoot, 'package.json'), 65_536, signal)
  const contractManifest = JSON.parse(contractPackageBytes.toString('utf8')) as {
    name?: string; version?: string; type?: string; dependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown>
  }
  if (contractManifest.name !== CONTRACT_PACKAGE || contractManifest.version !== version || contractManifest.type !== 'module'
    || Object.keys(contractManifest.dependencies ?? {}).length || Object.keys(contractManifest.optionalDependencies ?? {}).length) {
    fail('installed shared contract identity or dependency boundary differs')
  }
  names.set(`${CONTRACT_ROOT}/package.json`, join(contractRoot, 'package.json'))
  const contractLibraries = (await readdir(join(contractRoot, 'lib'))).filter(name => name.endsWith('.js')).sort()
  if (!contractLibraries.includes('index.js') || names.size + contractLibraries.length > MAX_ENTRIES) fail('shared contract entry bound exceeded')
  for (const name of contractLibraries) names.set(`${CONTRACT_ROOT}/lib/${name}`, join(contractRoot, 'lib', name))
  const files: { path: string; sourcePath: string; bytes: Buffer; sourceSha256: string; sourceMode: number }[] = []
  let total = 0
  for (const [path, sourcePath] of names) {
    const bytes = path === 'package.json' ? packageBytes : path === `${CONTRACT_ROOT}/package.json`
      ? contractPackageBytes : await asset(sourcePath, MAX_FILE, signal)
    total += bytes.length
    if (total > MAX_TOTAL) fail('asset byte bound exceeded')
    const sourceMode = (await lstat(sourcePath)).mode & 0o777
    files.push({ path, sourcePath, bytes, sourceSha256: hash(bytes), sourceMode })
  }
  const node = files.find(file => file.path === 'node')!.bytes
  if (!node.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) fail('Node interpreter is not native ELF')
  const nodeVersion = await io.command(nodePath, ['--version'], environment(packageRoot), signal, 10_000, 1024)
  const match = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(nodeVersion)
  if (!match || !(Number(match[1]) === 22 && Number(match[2]) >= 19 || Number(match[1]) >= 24)) fail('Node version is outside package engines')
  return files
}
async function verifySources(files: Awaited<ReturnType<typeof sourceAssets>>, signal: AbortSignal): Promise<void> {
  const seen = new Set<string>()
  for (const file of files) {
    if (seen.has(file.sourcePath)) continue
    seen.add(file.sourcePath)
    if (hash(await asset(file.sourcePath, MAX_FILE, signal)) !== file.sourceSha256
      || ((await lstat(file.sourcePath)).mode & 0o777) !== file.sourceMode) fail('installed source changed')
  }
}
function deployedBytes(file: Awaited<ReturnType<typeof sourceAssets>>[number], root: string): Buffer {
  if (file.path === 'package.json') return Buffer.from('{"type":"module"}\n')
  if (!file.path.startsWith('bin/')) return file.bytes
  const first = file.bytes.toString('utf8', 0, 128).split('\n', 1)[0] ?? ''
  if (!first.startsWith('#!')) fail('CLI has no shebang')
  return Buffer.concat([Buffer.from(`#!${join(root, 'node')}\n`), file.bytes.subarray(Buffer.byteLength(first) + 1)])
}
async function writeFile(path: string, bytes: Buffer, mode: number): Promise<void> {
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
  try { await fd.writeFile(bytes); await fd.chmod(mode); await fd.sync() } finally { await fd.close() }
}
async function verifyTree(root: string, entries: Entry[], signal: AbortSignal): Promise<void> {
  await io.directory(root)
  const expected = new Map(entries.map(item => [item.path, item]))
  const visit = async (folder: string, relative = ''): Promise<void> => {
    signal.throwIfAborted()
    const names = await readdir(folder)
    for (const name of names) {
      const path = relative ? `${relative}/${name}` : name
      const full = join(root, path), item = await lstat(full)
      if (item.isSymbolicLink() || item.nlink !== 1 && item.isFile() || process.getuid && item.uid !== process.getuid()) fail('deployed asset is linked or unowned')
      if (item.isDirectory()) {
        if (!RUNTIME_DIRECTORIES.includes(path) || !entries.some(entry => entry.path.startsWith(`${path}/`))
          || (item.mode & 0o777) !== 0o700) fail('unexpected runtime directory')
        await visit(full, path)
      } else if (item.isFile()) {
        if (path === 'receipt.json') continue
        const entry = expected.get(path)
        if (!entry || item.size !== entry.size || (item.mode & 0o777) !== entry.mode
          || hash(await asset(full, MAX_FILE, signal)) !== entry.sha256) fail(`deployed asset changed: ${path}`)
        expected.delete(path)
      } else fail('nonregular runtime entry')
    }
  }
  await visit(root)
  if (expected.size) fail('deployed asset missing')
  const receipt = await lstat(join(root, 'receipt.json'))
  if (!receipt.isFile() || receipt.nlink !== 1 || (receipt.mode & 0o777) !== 0o600) fail('unsafe receipt')
}
async function verifyRuntime(runtime: RsiAuthorityRuntime, signal: AbortSignal): Promise<void> {
  const env = environment(runtime.root)
  const modules = ['source-approval-authority', 'source-release-authority', 'source-adoption-authority',
    'task-observation-authority', 'live-qualification-authority', 'systemd-host-authority',
    'runtime-observer-protocol', 'adapter-process']
  const urls = modules.map(name => pathToFileURL(join(runtime.root, 'lib', `${name}.js`)).href)
  const script = `await Promise.all(${JSON.stringify(urls)}.map(url => import(url)))`
  await io.command(runtime.node.path, ['--input-type=module', '--eval', script], env, signal, 10_000, 4096)
  for (const [key, spec] of [['hostAttestor', runtime.executables.hostAttestor], ...Object.entries(runtime.releaseAdapters)] as [string, Pin][]) {
    const expected = key === 'hostAttestor' ? 'dsh-systemd-host-attestor-8' : 'dsh-local-release-adapter-1'
    const output = await io.command(runtime.node.path, [spec.path, '--version'], env, signal, 10_000, 4096)
    if (output !== expected) fail(`CLI version check failed: ${key}`)
  }
}

/** Read a copied runtime receipt through its physical stage path, retaining
 * the logical paths embedded in the original installation. */
export async function readRsiAuthorityRuntimeReceipt(input: {
  logicalHome: string; physicalHome: string; profile: string; signal?: AbortSignal
}): Promise<{ runtime: RsiAuthorityRuntime; receiptDigest: string }> {
  const { logicalHome, physicalHome, profile } = input
  if (!exactPath(logicalHome) || !exactPath(physicalHome) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile)) fail('invalid copied runtime binding')
  const root = join(physicalHome, 'rsi-authority-runtimes', profile)
  const source = await io.readStable(join(root, 'receipt.json'), 65_536, true)
  const receipt = JSON.parse(source.toString('utf8')) as Receipt
  const { digest, ...body } = receipt
  if (receipt.schemaVersion !== 1 || receipt.root !== join(logicalHome, 'rsi-authority-runtimes', profile)
    || !Array.isArray(receipt.entries) || receipt.entries.length > MAX_ENTRIES
    || !/^[a-f0-9]{64}$/u.test(digest) || hash(JSON.stringify(body)) !== digest) fail('copied runtime receipt differs')
  const signal = input.signal ?? new AbortController().signal
  await verifyTree(root, receipt.entries, signal)
  const { entries: _entries, ...runtime } = body
  return { runtime, receiptDigest: hash(source) }
}

/** Replace only the copied runtime under a stopped Home stage. The receipt and
 * shebangs keep their logical Home paths, so the transaction can rename Home. */
export async function replaceRsiAuthorityRuntimeInStage(input: {
  logicalHome: string; physicalHome: string; profile: string; signal?: AbortSignal
}, options: Options = {}): Promise<RsiAuthorityRuntime> {
  const previous = await readRsiAuthorityRuntimeReceipt(input)
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(120_000)])
  const parent = join(input.physicalHome, 'rsi-authority-runtimes')
  await io.directory(parent)
  const final = join(input.logicalHome, 'rsi-authority-runtimes', input.profile)
  if (previous.runtime.root !== final) fail('previous runtime root changed')
  const physical = join(parent, input.profile)
  const packageRoot = options.packageRoot ?? dirname(createRequire(import.meta.url).resolve('@dsh-enhanced/plugin-control-plane/package.json'))
  const nodePath = await realpath(options.nodePath ?? process.execPath)
  if (!exactPath(packageRoot) || !exactPath(nodePath)) fail('source paths must be canonical')
  const files = await sourceAssets(packageRoot, nodePath, signal)
  const logicalSourcePath = (path: string): string => path === input.physicalHome ? input.logicalHome
    : path.startsWith(`${input.physicalHome}${sep}`)
      ? join(input.logicalHome, relative(input.physicalHome, path)) : path
  const entries = files.map(file => {
    const bytes = deployedBytes(file, final)
    return { path: file.path, sha256: hash(bytes), size: bytes.length,
      mode: file.path === 'node' || file.path.startsWith('bin/') ? 0o700 : 0o600,
      sourcePath: logicalSourcePath(file.sourcePath), sourceSha256: file.sourceSha256,
      sourceSize: file.bytes.length, sourceMode: file.sourceMode }
  }).sort((a, b) => a.path.localeCompare(b.path))
  const runtime = result(final, entries)
  const stage = await mkdtemp(join(parent, `.${input.profile}-update-`))
  const backup = await mkdtemp(join(parent, `.${input.profile}-previous-`))
  await rm(backup, { recursive: true })
  let moved = false
  try {
    await chmod(stage, 0o700)
    for (const directory of RUNTIME_DIRECTORIES) await mkdir(join(stage, directory), { mode: 0o700 })
    for (const file of files) {
      const entry = entries.find(item => item.path === file.path)!
      await writeFile(join(stage, file.path), deployedBytes(file, final), entry.mode)
    }
    await verifySources(files, signal)
    const body = { ...runtime, entries }
    await writeFile(join(stage, 'receipt.json'), Buffer.from(JSON.stringify({ ...body, digest: hash(JSON.stringify(body)) })), 0o600)
    await verifyTree(stage, entries, signal)
    for (const directory of [...RUNTIME_DIRECTORIES].reverse()) await io.syncDirectory(join(stage, directory))
    await io.syncDirectory(stage)
    await rename(physical, backup); moved = true
    try { await rename(stage, physical) }
    catch (error) { await rename(backup, physical); moved = false; throw error }
    const actual = await readRsiAuthorityRuntimeReceipt(input)
    if (!isDeepStrictEqual(actual.runtime, runtime)) fail('replacement runtime differs')
    await verifyRuntime({ ...runtime, root: physical, node: { ...runtime.node, path: join(physical, 'node') },
      executables: Object.fromEntries(Object.entries(runtime.executables).map(([key, pin]) => [key, { ...pin, path: join(physical, 'bin', EXECUTABLES[key as Executable]) }])) as RsiAuthorityRuntime['executables'],
      releaseAdapters: Object.fromEntries(Object.entries(runtime.releaseAdapters).map(([key, pin]) => [key, { ...pin, path: join(physical, 'bin', `dsh-local-release-${key}.js`) }])) as RsiAuthorityRuntime['releaseAdapters'] }, signal)
    await rm(backup, { recursive: true })
    return runtime
  } catch (error) {
    if (moved) {
      await rm(physical, { recursive: true, force: true })
      await rename(backup, physical)
    }
    throw error
  } finally {
    await rm(stage, { recursive: true, force: true })
    if (!moved) await rm(backup, { recursive: true, force: true })
  }
}

/** Caller holds the home lifecycle lock. Only this function's stage/final claim is removed on failure. */
export async function prepareRsiAuthorityRuntime(input: { dshHome: string; profile: string; signal?: AbortSignal },
  options: Options = {}): Promise<RsiAuthorityRuntime> {
  if (!exactPath(input.dshHome) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.profile)) fail('invalid home or profile')
  if (process.platform !== 'linux') fail('Linux is required')
  await io.directory(input.dshHome, false)
  const packageRoot = options.packageRoot ?? dirname(createRequire(import.meta.url).resolve('@dsh-enhanced/plugin-control-plane/package.json'))
  const nodePath = await realpath(options.nodePath ?? process.execPath)
  if (!exactPath(packageRoot) || !exactPath(nodePath)) fail('source paths must be canonical')
  const parent = join(input.dshHome, 'rsi-authority-runtimes')
  try { await mkdir(parent, { mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  await io.directory(parent)
  const final = join(parent, input.profile)
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(120_000)])
  const files = await sourceAssets(packageRoot, nodePath, signal)
  const entries = files.map(file => {
    const bytes = deployedBytes(file, final)
    return { path: file.path, sha256: hash(bytes), size: bytes.length,
      mode: file.path === 'node' || file.path.startsWith('bin/') ? 0o700 : 0o600,
      sourcePath: file.sourcePath, sourceSha256: file.sourceSha256, sourceSize: file.bytes.length, sourceMode: file.sourceMode }
  }).sort((a, b) => a.path.localeCompare(b.path))
  const runtime = result(final, entries)
  try {
    await lstat(final)
    const receipt = JSON.parse((await io.readStable(join(final, 'receipt.json'), 65_536, true)).toString('utf8')) as Receipt
    const { digest, ...body } = receipt
    if (hash(JSON.stringify(body)) !== digest || !isDeepStrictEqual(body, { ...runtime, entries })) fail('runtime differs from receipt')
    await verifyTree(final, entries, signal)
    await verifySources(files, signal)
    await verifyRuntime(runtime, signal)
    return runtime
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try { await lstat(final); fail('existing runtime is incomplete') }
    catch (found) { if ((found as NodeJS.ErrnoException).code !== 'ENOENT') throw found }
  }
  const stage = await mkdtemp(join(parent, `.${input.profile}-stage-`))
  let claimed: { dev: number; ino: number } | undefined
  try {
    await chmod(stage, 0o700)
    for (const directory of RUNTIME_DIRECTORIES) await mkdir(join(stage, directory), { mode: 0o700 })
    for (const file of files) {
      signal.throwIfAborted()
      const entry = entries.find(item => item.path === file.path)!
      await writeFile(join(stage, file.path), deployedBytes(file, final), entry.mode)
    }
    await verifySources(files, signal)
    const body = { ...runtime, entries }
    await writeFile(join(stage, 'receipt.json'), Buffer.from(JSON.stringify({ ...body, digest: hash(JSON.stringify(body)) })), 0o600)
    for (const directory of [...RUNTIME_DIRECTORIES].reverse()) await io.syncDirectory(join(stage, directory))
    await io.syncDirectory(stage)
    signal.throwIfAborted()
    await mkdir(final, { mode: 0o700 })
    const identity = await lstat(final); claimed = { dev: identity.dev, ino: identity.ino }
    for (const name of ['bin', 'lib', 'node_modules', 'node', 'package.json', 'receipt.json']) await rename(join(stage, name), join(final, name))
    await verifyTree(final, entries, signal)
    await verifyRuntime(runtime, signal)
    await io.syncDirectory(parent)
    return runtime
  } catch (error) {
    if (claimed) {
      const current = await lstat(final).catch(() => undefined)
      if (current?.isDirectory() && current.dev === claimed.dev && current.ino === claimed.ino) await rm(final, { recursive: true, force: true })
    }
    throw error
  } finally { await rm(stage, { recursive: true, force: true }); await io.syncDirectory(parent) }
}
