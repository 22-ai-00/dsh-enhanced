import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type RsiServiceEnvironment = Readonly<Record<string, string>>

const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const releaseStages = ['PR', 'REVIEW', 'MERGE', 'BUILD', 'SIGN', 'PUBLISH', 'REGISTRY_VERIFY', 'CATALOG_ADMISSION'] as const
const allowedNames = new Set<string>([
  'DSH_SYSTEMD_HOST_ATTESTOR_CONFIG',
  ...releaseStages.map(stage => `DSH_RELEASE_${stage}_CONFIG`),
])
const maximumBindingBytes = 65_536
const maximumConfigBytes = 2_097_152

function fail(message: string): never { throw new Error(`rsi service environment: ${message}`) }

function canonicalPath(value: string, label: string): void {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || value.includes('\0')
    || /[\r\n]/u.test(value)) fail(`${label} must be canonical absolute`)
}

function scope(home: string, profile: string): void {
  canonicalPath(home, 'DSH_HOME')
  if (!profilePattern.test(profile)) fail('invalid profile')
}

export function isRsiServiceEnvironmentName(name: string): boolean { return allowedNames.has(name) }

export function rsiServiceEnvironmentPath(home: string, profile: string): string {
  scope(home, profile)
  return join(home, 'rsi-service-environments', `${profile}.json`)
}

async function ownedDirectory(path: string, privateDirectory: boolean): Promise<void> {
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.uid !== process.getuid?.() || (entry.mode & (privateDirectory ? 0o077 : 0o022)) !== 0
    || await realpath(path) !== path) fail(`unsafe directory: ${path}`)
}

async function ownedFile(path: string, maximum: number): Promise<string | undefined> {
  let descriptor
  try { descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const entry = await descriptor.stat(), linked = await lstat(path)
    if (!entry.isFile() || entry.nlink !== 1 || entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0
      || entry.size < 1 || entry.size > maximum || linked.dev !== entry.dev || linked.ino !== entry.ino
      || await realpath(path) !== path) fail(`unsafe file: ${path}`)
    return await descriptor.readFile('utf8')
  } finally { await descriptor.close() }
}

export async function validateRsiServiceEnvironment(
  value: unknown, home: string, profile: string,
): Promise<RsiServiceEnvironment> {
  scope(home, profile)
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('environment must be an object')
  const environment = value as Record<string, unknown>
  const result: Record<string, string> = {}
  for (const name of Object.keys(environment).sort()) {
    if (!isRsiServiceEnvironmentName(name)) fail(`unsupported environment name: ${name}`)
    const path = environment[name]
    canonicalPath(path as string, name)
    const configPath = path as string
    const withinProfiles = relative(join(home, 'profiles'), configPath)
    if (withinProfiles === '' || withinProfiles !== '..' && !withinProfiles.startsWith(`..${sep}`) && !isAbsolute(withinProfiles)) {
      // The profile tree is candidate writable and cannot hold authority configuration.
      fail(`configuration is inside profiles: ${name}`)
    }
    const content = await ownedFile(configPath, maximumConfigBytes)
    if (content === undefined) fail(`configuration is missing: ${name}`)
    result[name] = configPath
  }
  return result
}

export async function readRsiServiceEnvironment(home: string, profile: string): Promise<RsiServiceEnvironment | undefined> {
  const path = rsiServiceEnvironmentPath(home, profile)
  let parent
  try { parent = await lstat(dirname(path)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!parent.isDirectory()) fail('unsafe environment directory')
  await ownedDirectory(home, false)
  await ownedDirectory(dirname(path), true)
  const content = await ownedFile(path, maximumBindingBytes)
  if (content === undefined) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(content) } catch { fail('invalid environment JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('invalid environment binding')
  const binding = parsed as Record<string, unknown>
  if (Object.keys(binding).sort().join(',') !== 'dshHome,environment,profile,schemaVersion'
    || binding.schemaVersion !== 1 || binding.dshHome !== home || binding.profile !== profile) fail('environment binding does not match profile')
  return validateRsiServiceEnvironment(binding.environment, home, profile)
}
