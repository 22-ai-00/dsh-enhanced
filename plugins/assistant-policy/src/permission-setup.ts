import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isMap, parseDocument } from 'yaml'

export type PermissionPreset = 'workspace-write' | 'auto' | 'danger-full-access'

export interface PermissionSetupArgs {
  dshHome: string
  preset: PermissionPreset
  help: boolean
}

const allowedPresets = new Set<PermissionPreset>(['workspace-write', 'auto', 'danger-full-access'])

function argumentValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`assistant-policy permission setup: ${option} requires a value`)
  return value
}

export function parsePermissionSetupArgs(argv: readonly string[]): PermissionSetupArgs {
  const result: PermissionSetupArgs = {
    dshHome: process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh'),
    preset: 'workspace-write',
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!
    if (option === '--help' || option === '-h') {
      result.help = true
      continue
    }
    if (option === '--dsh-home') result.dshHome = argumentValue(argv, index++, option)
    else if (option === '--preset') result.preset = argumentValue(argv, index++, option) as PermissionPreset
    else throw new Error(`assistant-policy permission setup: unknown option: ${option}`)
  }
  if (!isAbsolute(result.dshHome)) throw new Error('assistant-policy permission setup: DSH home must be an absolute path')
  if (!allowedPresets.has(result.preset)) {
    throw new Error('assistant-policy permission setup: preset must be workspace-write, auto, or danger-full-access')
  }
  return result
}

export function permissionSetupUsage(): string {
  return [
    'Usage: dsh-permission-setup [--dsh-home <absolute-path>] --preset <workspace-write|auto|danger-full-access>',
    '',
    'Writes only permission.defaultPreset in DSH settings.yaml using an atomic replacement.',
  ].join('\n')
}

export async function setPermissionDefault(
  input: Pick<PermissionSetupArgs, 'dshHome' | 'preset'>,
): Promise<string> {
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

export async function runPermissionSetup(argv = process.argv.slice(2)): Promise<void> {
  const args = parsePermissionSetupArgs(argv)
  if (args.help) {
    process.stdout.write(`${permissionSetupUsage()}\n`)
    return
  }
  const settingsPath = await setPermissionDefault(args)
  process.stdout.write(`Updated ${settingsPath}: permission.defaultPreset=${args.preset}\n`)
}
