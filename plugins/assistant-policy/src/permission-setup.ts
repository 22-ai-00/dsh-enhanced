import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { type Document, isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from 'yaml'
import { type EffectiveProfileConfigReader, readEffectiveProfileConfig } from './profile-setup.js'

export type PermissionPreset = 'workspace-write' | 'auto' | 'danger-full-access'

export interface PermissionSetupArgs {
  dshHome: string
  profile?: string
  preset: PermissionPreset
  help: boolean
}

const allowedPresets = new Set<PermissionPreset>(['workspace-write', 'auto', 'danger-full-access'])
const profileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

function argumentValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`assistant-policy permission setup: ${option} requires a value`)
  return value
}

export function parsePermissionSetupArgs(argv: readonly string[]): PermissionSetupArgs {
  const result: PermissionSetupArgs = {
    dshHome: process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh'),
    preset: 'danger-full-access',
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!
    if (option === '--help' || option === '-h') {
      result.help = true
      continue
    }
    if (option === '--dsh-home') result.dshHome = argumentValue(argv, index++, option)
    else if (option === '--profile') result.profile = argumentValue(argv, index++, option)
    else if (option === '--preset') result.preset = argumentValue(argv, index++, option) as PermissionPreset
    else throw new Error(`assistant-policy permission setup: unknown option: ${option}`)
  }
  if (!isAbsolute(result.dshHome)) throw new Error('assistant-policy permission setup: DSH home must be an absolute path')
  if (result.profile !== undefined && !profileNamePattern.test(result.profile)) {
    throw new Error('assistant-policy permission setup: --profile must be a valid profile name')
  }
  if (!allowedPresets.has(result.preset)) {
    throw new Error('assistant-policy permission setup: preset must be workspace-write, auto, or danger-full-access')
  }
  return result
}

export function permissionSetupUsage(): string {
  return [
    'Usage: dsh-permission-setup [--dsh-home <absolute-path>] [--profile <name>] [--preset <workspace-write|auto|danger-full-access>]',
    '',
    'Default preset: danger-full-access (full file/network access, no approval prompts).',
    'An explicit --preset workspace-write or --preset auto selects a more restrictive default.',
    'With --profile, writes permission.defaultPreset into that profile\'s cordis.patch.yml.',
    'Without --profile, writes legacy settings.yaml; DSH imports it into the first started profile once.',
  ].join('\n')
}

export async function setPermissionDefault(
  input: Pick<PermissionSetupArgs, 'dshHome' | 'profile' | 'preset'>,
  readConfig: EffectiveProfileConfigReader = readEffectiveProfileConfig,
): Promise<string> {
  if (input.profile !== undefined) {
    if (!profileNamePattern.test(input.profile)) {
      throw new Error('assistant-policy permission setup: --profile must be a valid profile name')
    }
    let legacy = ''
    try {
      legacy = await readFile(join(input.dshHome, 'settings.yaml'), 'utf8')
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
    if (legacy.length > 0) {
      const document = parseDocument(legacy)
      if (document.errors.length > 0 || !isMap(document.contents)) {
        throw new Error('assistant-policy permission setup: settings.yaml is invalid YAML or not a mapping')
      }
      if (document.has('permission')) {
        throw new Error('assistant-policy permission setup: pending legacy settings.yaml permission section may override this profile; migrate it into the target profile before --profile setup')
      }
    }
    const nativeConfig = await readConfig(input.dshHome, input.profile, 'permission')
    return setProfilePermissionDefault(input.dshHome, input.profile, input.preset, nativeConfig)
  }
  const settingsPath = join(input.dshHome, 'settings.yaml')
  let source = ''
  try {
    source = await readFile(settingsPath, 'utf8')
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  const document = parseDocument(source.length === 0 ? '{}' : source)
  if (document.errors.length > 0) {
    throw new Error(`assistant-policy permission setup: settings.yaml is invalid YAML: ${document.errors[0]?.message}`)
  }
  if (!isMap(document.contents)) {
    throw new Error('assistant-policy permission setup: settings.yaml must contain a YAML mapping')
  }
  const permission = document.get('permission', true)
  if (permission !== undefined && !isMap(permission)) {
    throw new Error('assistant-policy permission setup: settings.permission must be a YAML mapping')
  }
  document.setIn(['permission', 'defaultPreset'], input.preset)
  const serialized = document.toString({ lineWidth: 0 })

  await mkdir(input.dshHome, { recursive: true })
  const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 })
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, settingsPath)
  return settingsPath
}

async function loadPatch(path: string): Promise<{ source: string; document: Document; sequence: YAMLSeq }> {
  let source = ''
  try {
    source = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  const document: Document = parseDocument(source)
  if (document.errors.length > 0) {
    throw new Error(`assistant-policy permission setup: ${path} is invalid YAML: ${document.errors[0]?.message}`)
  }
  if (document.contents === null) document.contents = new YAMLSeq()
  if (!isSeq(document.contents)) {
    throw new Error(`assistant-policy permission setup: ${path} must be a top-level YAML sequence of loader entries`)
  }
  return { source, document, sequence: document.contents }
}

function permissionRows(sequence: YAMLSeq): YAMLMap[] {
  const rows: YAMLMap[] = []
  for (const entry of sequence.items) {
    if (!isMap(entry)) continue
    if (entry.get('id') === 'permission') rows.push(entry)
    const inserted = entry.get('insert', true)
    if (isSeq(inserted)) {
      for (const row of inserted.items) if (isMap(row) && row.get('id') === 'permission') rows.push(row)
    }
  }
  return rows
}

async function setProfilePermissionDefault(
  dshHome: string,
  profile: string,
  preset: PermissionPreset,
  nativeConfig: YAMLMap,
): Promise<string> {
  const patchPath = join(dshHome, 'profiles', profile, 'cordis.patch.yml')
  const target = await loadPatch(patchPath)
  const rows = permissionRows(target.sequence)
  let row = rows.at(-1)
  if (row === undefined) {
    row = target.document.createNode({ id: 'permission', disabled: false }) as YAMLMap
    row.set('config', nativeConfig.clone())
    target.sequence.add(row)
  } else {
    row.set('disabled', false)
    if (row.get('config', true) === undefined) {
      row.set('config', nativeConfig.clone())
    }
  }
  const config = row.get('config', true)
  if (!isMap(config)) throw new Error('assistant-policy permission setup: permission config must be a YAML mapping')
  config.set('defaultPreset', preset)
  const serialized = target.document.toString({ lineWidth: 0 })
  if (serialized === target.source) return patchPath
  await mkdir(join(dshHome, 'profiles', profile), { recursive: true })
  const temporaryPath = `${patchPath}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 })
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, patchPath)
  return patchPath
}

export async function runPermissionSetup(argv = process.argv.slice(2)): Promise<void> {
  const args = parsePermissionSetupArgs(argv)
  if (args.help) {
    process.stdout.write(`${permissionSetupUsage()}\n`)
    return
  }
  const settingsPath = await setPermissionDefault(args)
  process.stdout.write(`Updated ${settingsPath}: permission.defaultPreset=${args.preset}\n`)
}
