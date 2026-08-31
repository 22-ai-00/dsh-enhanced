import { fileURLToPath } from 'node:url'
import { isAbsolute, relative, resolve } from 'node:path'
import type { CatalogPackage } from './catalog.js'

export class LockfileIntegrityError extends Error {
  constructor(message: string) { super(message); this.name = 'LockfileIntegrityError' }
}

interface PnpmPackageResolution {
  integrity?: string
  tarball?: string
  version?: string
}

interface PnpmImporterDependency {
  specifier?: string
  version?: string
}

interface ParsedPnpmLockfile {
  packages: ReadonlyMap<string, PnpmPackageResolution>
  importers: ReadonlyMap<string, ReadonlyMap<string, PnpmImporterDependency>>
}

function scalar(raw: string): string {
  const value = raw.trim()
  if (value === '' || value === 'null' || value === '~' || /^[&*!]|<<:/u.test(value)) {
    throw new LockfileIntegrityError('pnpm lockfile contains an unsupported or unsafe scalar')
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new LockfileIntegrityError('pnpm lockfile contains an unterminated quoted scalar')
    return value.slice(1, -1).replace(/''/gu, "'")
  }
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) throw new LockfileIntegrityError('pnpm lockfile contains an unterminated quoted scalar')
    try { return JSON.parse(value) as string } catch { throw new LockfileIntegrityError('pnpm lockfile contains an invalid quoted scalar') }
  }
  if ((value.includes(':') && !value.startsWith('file:'))
    || ['[', ']', '{', '}', ',', '#'].some(character => value.includes(character)) || /\s+#/u.test(value)) {
    throw new LockfileIntegrityError('pnpm lockfile uses unsupported ambiguous YAML syntax')
  }
  return value
}

function pair(line: string, indent: number): { key: string; value: string } | undefined {
  if (line.trim() === '' || line.trimStart().startsWith('#')) return undefined
  if (line.slice(0, indent) !== ' '.repeat(indent) || line[indent] === ' ') return undefined
  const remainder = line.slice(indent)
  const match = /^((?:'[^']*(?:''[^']*)*'|"(?:[^"\\]|\\.)*"|[^:]+)):(?: +(.*))?$/u.exec(remainder)
  if (match === null) return undefined
  return { key: scalar(match[1]!), value: match[2] === undefined ? '' : match[2].trim() }
}

function inlineResolution(raw: string): PnpmPackageResolution {
  const match = /^\{(.+)\}$/u.exec(raw)
  if (match === null) throw new LockfileIntegrityError('pnpm lockfile resolution mapping is ambiguous')
  const output: PnpmPackageResolution = {}
  const seen = new Set<string>()
  for (const field of match[1]!.split(/,\s*/u)) {
    const item = /^(integrity|tarball): +(.*)$/u.exec(field)
    if (item === null || seen.has(item[1]!)) throw new LockfileIntegrityError('pnpm lockfile resolution mapping is ambiguous')
    seen.add(item[1]!)
    output[item[1] as 'integrity' | 'tarball'] = scalar(item[2]!)
  }
  return output
}

function setOnce(target: PnpmPackageResolution | PnpmImporterDependency, key: 'integrity' | 'tarball' | 'version' | 'specifier',
  raw: string, label: string): void {
  const fields = target as Record<string, string | undefined>
  if (fields[key] !== undefined) throw new LockfileIntegrityError(`pnpm lockfile repeats ${label}`)
  fields[key] = scalar(raw)
}

/**
 * Parse only the pnpm v9 mappings needed to bind an install request. The
 * accepted subset is deliberately strict: duplicate keys, aliases, tags,
 * merge keys, tabs, and ambiguous inline YAML fail closed.
 */
function parsePnpmLockfile(source: string): ParsedPnpmLockfile {
  if (Buffer.byteLength(source) > 8 * 1024 * 1024 || source.includes('\t') || /(^|\s)[&*!][^\s]*/mu.test(source) || /^\s*<<:/mu.test(source)) {
    throw new LockfileIntegrityError('pnpm lockfile exceeds limits or uses aliases/tags/tabs')
  }
  const lines = source.replace(/\r\n?/gu, '\n').split('\n')
  let section: 'packages' | 'importers' | undefined
  let packageKey: string | undefined
  let inResolution = false
  let importerKey: string | undefined
  let dependencyGroup = false
  let dependencyKey: string | undefined
  let sawPackages = false
  let sawImporters = false
  const packages = new Map<string, PnpmPackageResolution>()
  const importers = new Map<string, Map<string, PnpmImporterDependency>>()
  for (const line of lines) {
    const top = pair(line, 0)
    if (top !== undefined) {
      section = top.value === '' && (top.key === 'packages' || top.key === 'importers') ? top.key : undefined
      if (section === 'packages') sawPackages = true
      if (section === 'importers') sawImporters = true
      packageKey = undefined; inResolution = false; importerKey = undefined; dependencyGroup = false; dependencyKey = undefined
      continue
    }
    if (section === 'packages') {
      const item = pair(line, 2)
      if (item !== undefined) {
        if (item.value !== '') throw new LockfileIntegrityError('pnpm lockfile package entry is ambiguous')
        packageKey = item.key; inResolution = false
        if (packages.has(packageKey)) throw new LockfileIntegrityError(`pnpm lockfile contains duplicate package key ${packageKey}`)
        packages.set(packageKey, {})
        continue
      }
      if (packageKey === undefined) continue
      const property = pair(line, 4)
      if (property !== undefined) {
        inResolution = property.key === 'resolution' && property.value === ''
        const target = packages.get(packageKey)!
        if (property.key === 'resolution' && property.value.startsWith('{')) {
          const resolution = inlineResolution(property.value)
          if (resolution.integrity !== undefined) setOnce(target, 'integrity', resolution.integrity, `integrity for ${packageKey}`)
          if (resolution.tarball !== undefined) setOnce(target, 'tarball', resolution.tarball, `tarball for ${packageKey}`)
        } else if (property.key === 'version') setOnce(target, 'version', property.value, `version for ${packageKey}`)
        continue
      }
      if (inResolution) {
        const resolution = pair(line, 6)
        const target = packages.get(packageKey)!
        if (resolution?.key === 'integrity') setOnce(target, 'integrity', resolution.value, `integrity for ${packageKey}`)
        if (resolution?.key === 'tarball') setOnce(target, 'tarball', resolution.value, `tarball for ${packageKey}`)
      }
      continue
    }
    if (section === 'importers') {
      const importer = pair(line, 2)
      if (importer !== undefined) {
        if (importer.value !== '') throw new LockfileIntegrityError('pnpm lockfile importer entry is ambiguous')
        importerKey = importer.key; dependencyGroup = false; dependencyKey = undefined
        if (importers.has(importerKey)) throw new LockfileIntegrityError(`pnpm lockfile contains duplicate importer ${importerKey}`)
        importers.set(importerKey, new Map())
        continue
      }
      if (importerKey === undefined) continue
      const group = pair(line, 4)
      if (group !== undefined) {
        dependencyGroup = group.value === '' && ['dependencies', 'devDependencies', 'optionalDependencies'].includes(group.key)
        dependencyKey = undefined
        continue
      }
      if (!dependencyGroup) continue
      const dependency = pair(line, 6)
      if (dependency !== undefined) {
        if (dependency.value !== '') throw new LockfileIntegrityError('pnpm lockfile importer dependency is ambiguous')
        dependencyKey = dependency.key
        const target = importers.get(importerKey)!
        if (target.has(dependencyKey)) throw new LockfileIntegrityError(`pnpm lockfile repeats importer dependency ${dependencyKey}`)
        target.set(dependencyKey, {})
        continue
      }
      if (dependencyKey !== undefined) {
        const property = pair(line, 8); const target = importers.get(importerKey)!.get(dependencyKey)!
        if (property?.key === 'specifier') setOnce(target, 'specifier', property.value, `specifier for ${dependencyKey}`)
        if (property?.key === 'version') setOnce(target, 'version', property.value, `importer version for ${dependencyKey}`)
      }
    }
  }
  if (!sawPackages || !sawImporters) throw new LockfileIntegrityError('pnpm lockfile has no packages or importers mapping')
  return { packages, importers }
}

export function parsePnpmPackageIntegrities(source: string): ReadonlyMap<string, string> {
  const parsed = parsePnpmLockfile(source)
  return new Map([...parsed.packages].flatMap(([key, value]) => value.integrity === undefined ? [] : [[key, value.integrity]]))
}

function importerDependency(parsed: ParsedPnpmLockfile, packageName: string): { specifier: string; version: string } {
  const importer = parsed.importers.get('.')
  const dependency = importer?.get(packageName)
  if (dependency === undefined || dependency.specifier === undefined || dependency.version === undefined) {
    throw new LockfileIntegrityError(`pnpm lockfile does not bind importer dependency ${packageName}`)
  }
  return { specifier: dependency.specifier, version: dependency.version }
}

function resolvedFileSpecifier(specifier: string, lockfileDirectory: string, requireAbsolute: boolean): string {
  if (!specifier.startsWith('file:') || specifier.startsWith('file://')) {
    throw new LockfileIntegrityError('pnpm lockfile local artifact specifier is not canonical')
  }
  const raw = specifier.slice('file:'.length)
  if (raw === '' || raw.includes('\0') || raw.includes('\r') || raw.includes('\n') || raw.includes('\\')
    || (requireAbsolute && !isAbsolute(raw)) || (!requireAbsolute && isAbsolute(raw))) {
    throw new LockfileIntegrityError('pnpm lockfile local artifact specifier is not canonical')
  }
  const path = requireAbsolute ? raw : resolve(lockfileDirectory, raw)
  const normalized = requireAbsolute ? path : relative(lockfileDirectory, path)
  if (resolve(path) !== path || raw !== normalized) throw new LockfileIntegrityError('pnpm lockfile local artifact specifier is not normalized')
  return path
}

function normalizedRelativeFileSpecifier(lockfileDirectory: string, artifactPath: string): string {
  const raw = relative(lockfileDirectory, artifactPath)
  if (raw === '' || raw.includes('\\') || isAbsolute(raw) || resolve(lockfileDirectory, raw) !== artifactPath) {
    throw new LockfileIntegrityError('approved local artifact cannot be represented by a canonical relative lockfile specifier')
  }
  return `file:${raw}`
}

function packageMatches(key: string, exact: string): boolean { return key === exact || key.startsWith(`${exact}(`) }
function peerSuffixed(value: string, exact: string): boolean { return value === exact || value.startsWith(`${exact}(`) }

export function verifyApprovedPackagesInLockfile(source: string, approved: readonly CatalogPackage[], lockfileDirectory = '.'): void {
  const parsed = parsePnpmLockfile(source)
  const directory = resolve(lockfileDirectory)
  for (const item of approved) {
    const dependency = importerDependency(parsed, item.package)
    let localReference = false
    if (item.registry !== undefined) {
      try { localReference = new URL(item.registry.reference).protocol === 'file:' } catch { /* parsed catalog prevents this */ }
    }
    if (!localReference) {
      if (dependency.specifier !== item.version || !(dependency.version === item.version || dependency.version.startsWith(`${item.version}(`))) {
        throw new LockfileIntegrityError(`pnpm lockfile does not bind ${item.package}@${item.version} to its approved registry specifier`)
      }
      const exact = `${item.package}@${item.version}`
      const matches = [...parsed.packages].filter(([key]) => packageMatches(key, exact))
      if (matches.length !== 1 || matches[0]![1].integrity !== item.integrity || matches[0]![1].tarball !== undefined) {
        throw new LockfileIntegrityError(`pnpm lockfile does not bind ${exact} to its approved integrity`)
      }
      continue
    }
    let artifactPath: string
    const registry = item.registry
    if (registry === undefined) throw new LockfileIntegrityError(`approved local artifact for ${item.package} is invalid`)
    try { artifactPath = fileURLToPath(registry.reference) } catch {
      throw new LockfileIntegrityError(`approved local artifact for ${item.package} is invalid`)
    }
    const expectedVersion = normalizedRelativeFileSpecifier(directory, artifactPath)
    if (resolvedFileSpecifier(dependency.specifier, directory, true) !== artifactPath
      || !peerSuffixed(dependency.version, expectedVersion)) {
      throw new LockfileIntegrityError(`pnpm lockfile importer does not bind ${item.package} to its approved local artifact`)
    }
    const exact = `${item.package}@${expectedVersion}`
    const matches = [...parsed.packages].filter(([key]) => packageMatches(key, exact))
    const resolution = matches.length === 1 ? matches[0]![1] : undefined
    const tarball = resolution?.tarball
    if (resolution === undefined || resolution.version !== item.version || resolution.integrity !== item.integrity
      || tarball === undefined || tarball !== expectedVersion
      || resolvedFileSpecifier(tarball, directory, false) !== artifactPath) {
      throw new LockfileIntegrityError(`pnpm lockfile does not bind ${item.package}@${item.version} to its approved local artifact and integrity`)
    }
  }
}
