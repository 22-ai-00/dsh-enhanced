import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, open, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from 'yaml'

const execFileAsync = promisify(execFile)
export const supportedHostVersions = new Set(['0.2.1-rc.2', '0.2.2-rc.1', '0.2.2-rc.3'])

export type EffectiveProfileConfigReader = (dshHome: string, profile: string, rowId: string) => Promise<YAMLMap>

function inside(parent: string, child: string): boolean {
  const suffix = relative(parent, child)
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix))
}

async function validateHostExecutable(executable: string, dshHome: string): Promise<string> {
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
          || !inside(hostRoot, executable) || inside(dshHome, hostRoot)) {
          throw new Error('assistant-policy setup: selected dsh executable is not an approved Host')
        }
        const hostRequire = createRequire(manifestPath)
        const bootManifest = JSON.parse(await readFile(hostRequire.resolve('@deepseek-ai/dsh-app-boot/package.json'), 'utf8')) as {
          name?: string; version?: string
        }
        if (bootManifest.name !== '@deepseek-ai/dsh-app-boot' || !supportedHostVersions.has(bootManifest.version ?? '')) {
          throw new Error('assistant-policy setup: selected dsh boot does not match the Host')
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
  throw new Error('assistant-policy setup: PATH dsh is not owned by an approved Host')
}

async function resolveBoundHostExecutable(dshHome: string): Promise<string | undefined> {
  const bindingPath = join(dshHome, '.dsh-rsi-host.json')
  let handle
  try {
    handle = await open(bindingPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw new Error('assistant-policy setup: bound host file .dsh-rsi-host.json is inaccessible or a symlink', { cause: error })
  }
  let raw: string
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > 16_384
      || (info.mode & 0o077) !== 0 || (process.getuid !== undefined && info.uid !== process.getuid())) {
      throw new Error('assistant-policy setup: bound host file .dsh-rsi-host.json has unsafe permissions or type')
    }
    raw = await handle.readFile({ encoding: 'utf8' })
  } finally {
    await handle.close()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error: unknown) {
    throw new Error('assistant-policy setup: bound host file .dsh-rsi-host.json is invalid JSON', { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(',') !== 'cacheRoot,receiptDigest,schemaVersion,version') {
    throw new Error('assistant-policy setup: bound host file .dsh-rsi-host.json has an unexpected schema')
  }
  const binding = parsed as { schemaVersion?: unknown; cacheRoot?: unknown; version?: unknown; receiptDigest?: unknown }
  if (binding.schemaVersion !== 1 || typeof binding.cacheRoot !== 'string' || !isAbsolute(binding.cacheRoot)
    || resolve(binding.cacheRoot) !== binding.cacheRoot || typeof binding.version !== 'string'
    || !supportedHostVersions.has(binding.version) || typeof binding.receiptDigest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(binding.receiptDigest)) {
    throw new Error('assistant-policy setup: bound host file .dsh-rsi-host.json names an unsupported or invalid Host')
  }
  const candidate = join(binding.cacheRoot, binding.version, 'node_modules', '.bin', 'dsh')
  try {
    await access(candidate)
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  const executable = await realpath(candidate)
  return validateHostExecutable(executable, dshHome)
}

export async function resolveDshExecutable(dshHome: string): Promise<string> {
  const searchPath = process.env.PATH ?? ''
  for (const directory of searchPath.split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue
    let executable: string
    try {
      const candidate = join(directory, 'dsh')
      await access(candidate)
      executable = await realpath(candidate)
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
    return validateHostExecutable(executable, dshHome)
  }
  const bound = await resolveBoundHostExecutable(dshHome)
  if (bound !== undefined) return bound
  throw new Error('assistant-policy setup: dsh executable is unavailable on PATH')
}

export function findRow(sequence: YAMLSeq, rowId: string): YAMLMap | undefined {
  for (const entry of sequence.items) {
    if (!isMap(entry)) continue
    if (entry.get('id') === rowId) return entry
    for (const key of ['config', 'insert']) {
      const children = entry.get(key, true)
      if (isSeq(children)) {
        const found = findRow(children, rowId)
        if (found !== undefined) return found
      }
    }
  }
  return undefined
}

/** Reads the whole native `dsh --profile <p> --dump-config` entry sequence. */
export type EffectiveProfileDumpReader = (dshHome: string, profile: string) => Promise<YAMLSeq>

export const readEffectiveProfileDump: EffectiveProfileDumpReader = async (dshHome, profile) => {
  const executable = await resolveDshExecutable(dshHome)
  const { stdout } = await execFileAsync(executable, ['--profile', profile, '--dump-config'], {
    env: { ...process.env, DSH_HOME: dshHome, NODE_PATH: '', NODE_OPTIONS: '' },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  })
  const document = parseDocument(stdout)
  if (document.errors.length > 0 || !isSeq(document.contents)) {
    throw new Error('assistant-policy setup: native profile dump is not a YAML entry sequence')
  }
  return document.contents
}

export const readEffectiveProfileConfig: EffectiveProfileConfigReader = async (dshHome, profile, rowId) => {
  const row = findRow(await readEffectiveProfileDump(dshHome, profile), rowId)
  if (row === undefined) throw new Error(`assistant-policy setup: native profile has no ${rowId} row`)
  const config = row.get('config', true)
  if (config === undefined) return new YAMLMap()
  if (!isMap(config)) throw new Error(`assistant-policy setup: native ${rowId} config must be a YAML mapping`)
  return config.clone() as YAMLMap
}
