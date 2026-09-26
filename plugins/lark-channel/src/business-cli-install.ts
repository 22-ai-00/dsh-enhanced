import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

const PACKAGE = '@larksuite/cli'
const REGISTRY = 'https://registry.npmjs.org'
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 150 * 1024 * 1024
const MAX_BINARY_BYTES = 150 * 1024 * 1024
const MAX_COMMAND_OUTPUT = 128 * 1024
const METADATA_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 120_000
const COMMAND_TIMEOUT_MS = 10_000
const BINARY_NAME = process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli'

type Metadata = { version: string; dist: { integrity: string; tarball: string } }
type RunResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function assertVersion(version: string): void {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) {
    throw new Error('Lark CLI registry latest is not a stable exact version')
  }
}

function supportedVersion(version: string): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version)
  return parts !== null && parts[1] === '1'
    && (BigInt(parts[2]!) > 0n || BigInt(parts[3]!) >= 85n)
}

async function run(command: string, args: string[], timeoutMs: number, maxOutput = MAX_COMMAND_OUTPUT): Promise<RunResult> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let exceeded = false
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (Buffer.byteLength(stdout) > maxOutput) { exceeded = true; child.kill('SIGKILL') }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (Buffer.byteLength(stderr) > maxOutput) { exceeded = true; child.kill('SIGKILL') }
    })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (exceeded) reject(new Error('Lark CLI command output exceeded limit'))
      else resolveResult({ code, signal, stdout, stderr })
    })
  })
}

async function commandVersion(command: string): Promise<string | undefined> {
  try {
    const versionResult = await run(command, ['--version'], COMMAND_TIMEOUT_MS)
    if (versionResult.code !== 0 || versionResult.signal !== null) return undefined
    const match = /^lark-cli version (\d+\.\d+\.\d+)\s*$/u.exec(versionResult.stdout.trim())
    if (!match || !supportedVersion(match[1]!)) return undefined
    const contracts: Array<{ args: string[]; required: string[] }> = [
      { args: ['config', 'init', '--help'], required: ['--app-secret-stdin', '--name'] },
      { args: ['auth', 'login', '--help'], required: ['--domain', 'all'] },
      { args: ['skills', 'list', '--help'], required: ['skills list'] },
      { args: ['skills', 'read', '--help'], required: ['skills read'] },
    ]
    for (const contract of contracts) {
      const result = await run(command, contract.args, COMMAND_TIMEOUT_MS)
      const output = result.stdout + result.stderr
      if (result.code !== 0 || result.signal !== null || !contract.required.every(token => output.includes(token))) {
        return undefined
      }
    }
    return match[1]
  } catch {
    return undefined
  }
}

async function executable(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch { return false }
}

async function pathCandidate(command: string): Promise<string | undefined> {
  if (isAbsolute(command)) return await executable(command) ? await realpath(command) : undefined
  if (command !== 'lark-cli') return undefined
  for (const directory of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!directory || !isAbsolute(directory)) continue
    const candidate = join(directory, process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli')
    if (await executable(candidate)) return await realpath(candidate)
  }
  return undefined
}

async function download(url: string, path: string, maxBytes: number, timeoutMs: number): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`Lark CLI download failed: HTTP ${response.status}`)
  const { open } = await import('node:fs/promises')
  const file = await open(path, 'wx', 0o600)
  const sha512 = createHash('sha512')
  let total = 0
  try {
    for await (const chunk of response.body) {
      total += chunk.byteLength
      if (total > maxBytes) throw new Error('Lark CLI download exceeded size limit')
      sha512.update(chunk)
      for (let offset = 0; offset < chunk.byteLength;) {
        const written = await file.write(chunk.subarray(offset))
        if (written.bytesWritten === 0) throw new Error('Lark CLI download write stalled')
        offset += written.bytesWritten
      }
    }
  } finally { await file.close() }
  if (total === 0) throw new Error('Lark CLI download was empty')
  return sha512.digest('base64')
}

async function extractEntry(archive: string, entry: string, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  const tar = process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar'
  const result = await run(tar, ['-xOzf', archive, entry], timeoutMs, maxBytes)
  if (result.code !== 0 || result.signal !== null) throw new Error('Lark CLI archive extraction failed')
  return Buffer.from(result.stdout, 'utf8')
}

async function extractBinary(archive: string, output: string): Promise<void> {
  const tar = process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar'
  await new Promise<void>((resolveResult, reject) => {
    const args = archive.endsWith('.zip') ? ['-xOf', archive, BINARY_NAME] : ['-xOzf', archive, BINARY_NAME]
    const child = spawn(tar, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const chunks: Buffer[] = []
    let bytes = 0
    let stderr = ''
    let exceeded = false
    const timer = setTimeout(() => child.kill('SIGKILL'), DOWNLOAD_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_BINARY_BYTES) { exceeded = true; child.kill('SIGKILL') }
      else chunks.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (Buffer.byteLength(stderr) > MAX_COMMAND_OUTPUT) child.kill('SIGKILL')
    })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (code !== 0 || signal !== null || exceeded || bytes === 0) reject(new Error('Lark CLI binary extraction failed'))
      else writeFile(output, Buffer.concat(chunks), { mode: 0o700 }).then(resolveResult, reject)
    })
  })
  if (process.platform !== 'win32') await chmod(output, 0o700)
}

function archiveTarget(version: string): { name: string; url: string; mirrorUrl: string } {
  const platforms: Record<string, string> = { darwin: 'darwin', linux: 'linux', win32: 'windows' }
  const architectures: Record<string, string> = { x64: 'amd64', arm64: 'arm64', riscv64: 'riscv64' }
  const platform = platforms[process.platform]
  const architecture = architectures[process.arch]
  if (!platform || !architecture) throw new Error(`Lark CLI does not support ${process.platform}-${process.arch}`)
  const name = `lark-cli-${version}-${platform}-${architecture}${platform === 'windows' ? '.zip' : '.tar.gz'}`
  return {
    name,
    url: `https://github.com/larksuite/cli/releases/download/v${version}/${name}`,
    mirrorUrl: `https://registry.npmmirror.com/-/binary/lark-cli/v${version}/${name}`,
  }
}

async function managedInstalled(toolsRoot: string): Promise<{ command: string; version: string } | undefined> {
  let entries: string[]
  try { entries = await readdir(toolsRoot) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const versions = entries.filter(version => /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version))
    .sort((left, right) => {
      const a = left.split('.').map(BigInt)
      const b = right.split('.').map(BigInt)
      for (let index = 0; index < 3; index++) {
        if (a[index]! > b[index]!) return -1
        if (a[index]! < b[index]!) return 1
      }
      return 0
    })
  for (const version of versions) {
    const versionDir = join(toolsRoot, version)
    const platformDir = join(versionDir, `${process.platform}-${process.arch}`)
    const command = join(platformDir, BINARY_NAME)
    try {
      // Reject symlinked managed candidates before reading any provenance or
      // invoking an executable outside the installer's version directory.
      if (!(await lstat(versionDir)).isDirectory() || !(await lstat(platformDir)).isDirectory()
        || !(await lstat(command)).isFile()
        || !(await lstat(join(platformDir, 'provenance.json'))).isFile()) continue
      const provenance = JSON.parse(await readFile(join(platformDir, 'provenance.json'), 'utf8')) as {
        package?: string; version?: string; npmIntegrity?: string; releaseArchive?: string; releaseSha256?: string
      }
      if (provenance.package !== PACKAGE || provenance.version !== version
        || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(provenance.npmIntegrity ?? '')
        || !/^[0-9a-f]{64}$/iu.test(provenance.releaseSha256 ?? '')
        || provenance.releaseArchive !== archiveTarget(version).name) continue
      if (await commandVersion(command) === version) return { command: await realpath(command), version }
    } catch { /* An invalid candidate must not shadow a usable older version. */ }
  }
  return undefined
}

async function managedRoot(dshHome: string): Promise<string> {
  const first = resolve(dshHome, '.dsh-enhanced')
  const second = join(first, 'tools')
  const third = join(second, 'lark-cli')
  for (const path of [first, second, third]) {
    try {
      if (!(await lstat(path)).isDirectory()) throw new Error('Lark CLI managed path is not a real directory')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return third
}

async function latestMetadata(): Promise<Metadata> {
  const response = await fetch(`${REGISTRY}/@larksuite%2fcli/latest`, {
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS), redirect: 'error',
  })
  if (!response.ok) throw new Error(`Lark CLI registry lookup failed: HTTP ${response.status}`)
  const raw = await response.text()
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('Lark CLI metadata exceeded size limit')
  const metadata = JSON.parse(raw) as Metadata
  assertVersion(metadata.version)
  if (!supportedVersion(metadata.version)) throw new Error('Lark CLI latest is outside the verified command contract range')
  const expectedTarball = `${REGISTRY}/@larksuite/cli/-/cli-${metadata.version}.tgz`
  if (metadata.dist?.tarball !== expectedTarball || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(metadata.dist.integrity)) {
    throw new Error('Lark CLI registry metadata has invalid archive provenance')
  }
  return metadata
}

/** Ensure a contract-compatible official Lark CLI without changing global npm or user configuration. */
export async function ensureLarkBusinessCli(options: { dshHome: string; command?: string }): Promise<{ command: string; version: string }> {
  if (!isAbsolute(options.dshHome)) throw new Error('DSH_HOME must be an absolute path')
  const existing = await pathCandidate(options.command ?? 'lark-cli')
  if (options.command && !existing) throw new Error('Configured Lark CLI command is not an executable absolute path or PATH lark-cli')
  if (existing) {
    const version = await commandVersion(existing)
    if (version) return { command: existing, version }
    if (options.command) throw new Error('Configured Lark CLI does not satisfy the required command contract')
  }

  const toolsRoot = await managedRoot(options.dshHome)
  const managed = await managedInstalled(toolsRoot)
  if (managed) return managed

  const metadata = await latestMetadata()
  const target = archiveTarget(metadata.version)
  const versionDir = join(toolsRoot, metadata.version, `${process.platform}-${process.arch}`)
  const installed = join(versionDir, BINARY_NAME)
  if (await executable(installed) && await commandVersion(installed) === metadata.version) {
    return { command: await realpath(installed), version: metadata.version }
  }
  await mkdir(toolsRoot, { recursive: true, mode: 0o700 })
  await managedRoot(options.dshHome)
  const stage = await mkdtemp(join(toolsRoot, '.stage-'))
  try {
    const packageArchive = join(stage, 'package.tgz')
    const packageDigest = await download(metadata.dist.tarball, packageArchive, MAX_PACKAGE_BYTES, DOWNLOAD_TIMEOUT_MS)
    if (`sha512-${packageDigest}` !== metadata.dist.integrity) throw new Error('Lark CLI npm archive integrity mismatch')
    const packageManifest = JSON.parse((await extractEntry(packageArchive,
      'package/package.json', 64 * 1024, COMMAND_TIMEOUT_MS)).toString('utf8')) as { name?: string; version?: string }
    if (packageManifest.name !== PACKAGE || packageManifest.version !== metadata.version) {
      throw new Error('Lark CLI npm archive identity mismatch')
    }
    const checksums = await extractEntry(packageArchive, 'package/checksums.txt', 64 * 1024, COMMAND_TIMEOUT_MS)
    const match = checksums.toString('utf8').split(/\r?\n/u)
      .map(line => /^([0-9a-f]{64})  (.+)$/iu.exec(line))
      .find(parts => parts?.[2] === target.name)
    if (!match) throw new Error('Lark CLI release checksum missing from official npm archive')
    const releaseArchive = join(stage, target.name)
    let releaseVerified = false
    let lastReleaseError: unknown
    // The official npm installer uses this same GitHub → npmmirror fallback;
    // both sources must match its npm-integrity-protected SHA-256 checksum.
    for (const url of [target.url, target.mirrorUrl]) {
      await rm(releaseArchive, { force: true })
      try {
        await download(url, releaseArchive, MAX_ARCHIVE_BYTES, DOWNLOAD_TIMEOUT_MS)
        const releaseDigest = createHash('sha256').update(await readFile(releaseArchive)).digest('hex')
        if (releaseDigest.toLowerCase() !== match[1]?.toLowerCase()) throw new Error('Lark CLI release checksum mismatch')
        releaseVerified = true
        break
      } catch (error) { lastReleaseError = error }
    }
    if (!releaseVerified) throw lastReleaseError
    const stageBinary = join(stage, BINARY_NAME)
    await extractBinary(releaseArchive, stageBinary)
    if (await commandVersion(stageBinary) !== metadata.version) throw new Error('Lark CLI release binary failed contract verification')
    await writeFile(join(stage, 'provenance.json'), JSON.stringify({
      package: PACKAGE, version: metadata.version, npmIntegrity: metadata.dist.integrity,
      releaseArchive: target.name, releaseSha256: match[1],
    }) + '\n', { mode: 0o600 })
    await rm(packageArchive)
    await rm(releaseArchive)
    await mkdir(join(toolsRoot, metadata.version), { recursive: true, mode: 0o700 })
    try { await rename(stage, versionDir) }
    catch (error) {
      if (await executable(installed) && await commandVersion(installed) === metadata.version) {
        return { command: await realpath(installed), version: metadata.version }
      }
      throw error
    }
    return { command: await realpath(installed), version: metadata.version }
  } finally { await rm(stage, { recursive: true, force: true }) }
}
