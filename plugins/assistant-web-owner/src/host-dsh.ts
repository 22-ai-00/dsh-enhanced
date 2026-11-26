import { execFile } from 'node:child_process'
import { constants, lstatSync, realpathSync } from 'node:fs'
import { access, open, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { isMap, isScalar, type Node, type YAMLMap, type YAMLSeq } from 'yaml'

const execFileAsync = promisify(execFile)
const supportedHostVersions = new Set(['0.2.1-rc.2', '0.2.2-rc.1', '0.2.2-rc.3', '0.2.2-rc.5'])

export type Fail = (message: string) => never

export function globalDshDatabasePath(slug: string): string {
  return join(homedir(), '.dsh', `${slug}.sqlite`)
}

export function mergeConfigMaps(base: YAMLMap, overlay: YAMLMap, fail: Fail): YAMLMap {
  if (!isMap(base)) fail('config must be a mapping')
  const result = base.clone() as YAMLMap
  for (const pair of overlay.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') fail('config keys must be strings')
    const inherited = result.get(pair.key.value, true)
    const value = pair.value as Node | null
    result.set(pair.key.value, isMap(inherited) && isMap(value) ? mergeConfigMaps(inherited, value, fail) : value?.clone() ?? null)
  }
  return result
}

export function findExactRow(
  rows: YAMLSeq,
  slug: string,
  options: { required: boolean; allowDisabled?: boolean; label?: string },
  fail: Fail,
): YAMLMap | undefined {
  const id = `dsh-ray-${slug}`
  const name = `@dsh-ray/${slug}`
  const matches = rows.items.filter(item => isMap(item) && (item.get('id') === id || item.get('name') === name)) as YAMLMap[]
  if (matches.length > 1) fail(`duplicate or shadowed ${id}`)
  const found = matches[0]
  if (found === undefined) {
    if (options.required) fail(options.label ?? `install ${name} before setup`)
    return undefined
  }
  if (found.get('id') !== id || (found.has('name') && found.get('name') !== name)) fail(`invalid or disabled ${id}`)
  if (found.has('disabled') && found.get('disabled') !== false) {
    if (options.allowDisabled) return undefined
    fail(`invalid or disabled ${id}`)
  }
  return found
}

export function canonicalPath(value: string, label: string, fail: Fail, rejectLeafSymlink = false): string {
  let cursor = value
  const suffix: string[] = []
  for (;;) {
    let stat
    try {
      stat = lstatSync(cursor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail(`${label} has an inaccessible filesystem ancestor`)
      const parent = dirname(cursor)
      if (parent === cursor) fail(`${label} has no existing filesystem ancestor`)
      suffix.unshift(basename(cursor))
      cursor = parent
      continue
    }
    if (rejectLeafSymlink && suffix.length === 0 && stat.isSymbolicLink()) fail(`${label} must not be a symbolic link`)
    try {
      return resolve(realpathSync(cursor), ...suffix)
    } catch {
      fail(`${label} has an unresolved filesystem ancestor`)
    }
  }
}

function insideDirectory(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export function withinDshHome(resolvedPath: string, dshHome: string, label: string, fail: Fail): string {
  const canonical = canonicalPath(resolvedPath, label, fail, true)
  const homeRoot = canonicalPath(dshHome, 'DSH_HOME', fail)
  if (!insideDirectory(homeRoot, canonical)) fail(`${label} must be within DSH_HOME`)
  return canonical
}

export function publishedDatabaseDefault(value: unknown, expected: string): boolean {
  return isScalar(value) && (value.tag === undefined || value.tag === 'tag:yaml.org,2002:str') && normalize(String(value.value)) === normalize(expected)
}

function pathExists(path: string, fail: Fail): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    fail(`cannot inspect inherited database state at ${path}`)
  }
}

export function sqliteStateExists(databasePath: string, companion: boolean, fail: Fail): boolean {
  const databases = companion ? [databasePath, `${databasePath}.preparations`] : [databasePath]
  return databases.some(value => [value, `${value}-journal`, `${value}-wal`, `${value}-shm`].some(item => pathExists(item, fail)))
}

async function validateBoundHostExecutable(executable: string, dshHome: string, fail: Fail): Promise<string> {
  const canonicalHome = canonicalPath(dshHome, 'DSH_HOME', fail)
  let hostRoot = dirname(executable)
  for (;;) {
    try {
      const manifestPath = join(hostRoot, 'package.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        name?: string; version?: string; bin?: { dsh?: string }
      }
      if (manifest.name === '@deepseek-ai/dsh') {
        if (!supportedHostVersions.has(manifest.version ?? '') || typeof manifest.bin?.dsh !== 'string'
          || await realpath(join(hostRoot, manifest.bin.dsh)) !== executable
          || !insideDirectory(hostRoot, executable) || insideDirectory(canonicalHome, hostRoot)) {
          fail('selected dsh executable is not an approved Host')
        }
        const hostRequire = createRequire(manifestPath)
        const bootManifest = JSON.parse(await readFile(hostRequire.resolve('@deepseek-ai/dsh-app-boot/package.json'), 'utf8')) as {
          name?: string; version?: string
        }
        if (bootManifest.name !== '@deepseek-ai/dsh-app-boot' || !supportedHostVersions.has(bootManifest.version ?? '')) {
          fail('selected dsh boot does not match the Host')
        }
        return executable
      }
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
    const parent = dirname(hostRoot)
    if (parent === hostRoot) break
    hostRoot = parent
  }
  fail('bound dsh executable is not owned by an approved Host')
}

/** Resolve the approved DSH executable bound under `$DSH_HOME/.dsh-ray-host.json`, failing closed on unsafe metadata. */
export async function resolveBoundHostExecutable(dshHome: string, fail: Fail): Promise<string | undefined> {
  const bindingPath = join(dshHome, '.dsh-ray-host.json')
  let handle
  try {
    handle = await open(bindingPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    fail('bound host file .dsh-ray-host.json is inaccessible or a symlink')
  }
  let raw: string
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > 16_384
      || (info.mode & 0o077) !== 0 || (process.getuid !== undefined && info.uid !== process.getuid())) {
      fail('bound host file .dsh-ray-host.json has unsafe permissions or type')
    }
    raw = await handle.readFile({ encoding: 'utf8' })
  } finally {
    await handle.close()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail('bound host file .dsh-ray-host.json is invalid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(',') !== 'cacheRoot,receiptDigest,schemaVersion,version') {
    fail('bound host file .dsh-ray-host.json has an unexpected schema')
  }
  const binding = parsed as { schemaVersion?: unknown; cacheRoot?: unknown; version?: unknown; receiptDigest?: unknown }
  if (binding.schemaVersion !== 1 || typeof binding.cacheRoot !== 'string' || !isAbsolute(binding.cacheRoot)
    || resolve(binding.cacheRoot) !== binding.cacheRoot || typeof binding.version !== 'string'
    || !supportedHostVersions.has(binding.version) || typeof binding.receiptDigest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(binding.receiptDigest)) {
    fail('bound host file .dsh-ray-host.json names an unsupported or invalid Host')
  }
  const candidate = join(binding.cacheRoot, binding.version, 'node_modules', '.bin', 'dsh')
  try {
    await access(candidate)
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  return validateBoundHostExecutable(await realpath(candidate), dshHome, fail)
}

/** Run `dsh --profile <p> --dump-config` from PATH or fall back to verified `$DSH_HOME/.dsh-ray-host.json`. */
export async function dumpEffectiveProfile(dshHome: string, profile: string, fail: Fail, failureMessage: string): Promise<string> {
  const execOpts = {
    env: { ...process.env, DSH_HOME: dshHome },
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  }
  try {
    const result = await execFileAsync('dsh', ['--profile', profile, '--dump-config'], execOpts)
    return result.stdout
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      const executable = await resolveBoundHostExecutable(dshHome, fail)
      if (executable !== undefined) {
        try {
          const result = await execFileAsync(executable, ['--profile', profile, '--dump-config'], {
            ...execOpts,
            env: { ...process.env, DSH_HOME: dshHome, NODE_PATH: '', NODE_OPTIONS: '' },
          })
          return result.stdout
        } catch { fail(failureMessage) }
      }
    }
    fail(failureMessage)
  }
}
