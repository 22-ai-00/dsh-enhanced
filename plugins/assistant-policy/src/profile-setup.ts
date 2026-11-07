import { execFile } from 'node:child_process'
import { access, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from 'yaml'

const execFileAsync = promisify(execFile)
const supportedHostVersions = new Set(['0.2.1-rc.2', '0.2.2-rc.1'])

export type EffectiveProfileConfigReader = (dshHome: string, profile: string, rowId: string) => Promise<YAMLMap>

function inside(parent: string, child: string): boolean {
  const suffix = relative(parent, child)
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix))
}

async function selectedDshExecutable(dshHome: string): Promise<string> {
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
  const executable = await selectedDshExecutable(dshHome)
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
