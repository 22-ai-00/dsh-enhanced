import type { CatalogPackage } from './catalog.js'

export class LockfileIntegrityError extends Error {
  constructor(message: string) { super(message); this.name = 'LockfileIntegrityError' }
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
  if (/[:[\]{},#]|\s+#/u.test(value)) throw new LockfileIntegrityError('pnpm lockfile uses unsupported ambiguous YAML syntax')
  return value
}

function pair(line: string, indent: number): { key: string; value: string } | undefined {
  if (line.trim() === '' || line.trimStart().startsWith('#')) return undefined
  if (line.slice(0, indent) !== ' '.repeat(indent) || line[indent] === ' ') return undefined
  const match = new RegExp(`^ {${indent}}((?:'[^']*(?:''[^']*)*'|"(?:[^"\\\\]|\\\\.)*"|[^:]+)):(?: +(.*))?$`, 'u').exec(line)
  if (match === null) return undefined
  return { key: scalar(match[1]!), value: match[2] === undefined ? '' : match[2].trim() }
}

/**
 * Parse only the pnpm v9 packages mapping needed for integrity verification.
 * The accepted subset is deliberately strict: duplicate keys, aliases, tags,
 * merge keys, tabs, and ambiguous inline YAML fail closed.
 */
export function parsePnpmPackageIntegrities(source: string): ReadonlyMap<string, string> {
  if (Buffer.byteLength(source) > 8 * 1024 * 1024 || source.includes('\t') || /(^|\s)[&*!][^\s]*/mu.test(source) || /^\s*<<:/mu.test(source)) {
    throw new LockfileIntegrityError('pnpm lockfile exceeds limits or uses aliases/tags/tabs')
  }
  const lines = source.replace(/\r\n?/gu, '\n').split('\n')
  let inPackages = false
  let current: string | undefined
  let inResolution = false
  const results = new Map<string, string>()
  const packageKeys = new Set<string>()
  for (const line of lines) {
    const top = pair(line, 0)
    if (top !== undefined) {
      inPackages = top.key === 'packages' && top.value === ''
      current = undefined
      inResolution = false
      continue
    }
    if (!inPackages) continue
    const item = pair(line, 2)
    if (item !== undefined) {
      current = item.key
      inResolution = false
      if (packageKeys.has(current)) throw new LockfileIntegrityError(`pnpm lockfile contains duplicate package key ${current}`)
      packageKeys.add(current)
      continue
    }
    if (current === undefined) continue
    const property = pair(line, 4)
    if (property !== undefined) {
      inResolution = property.key === 'resolution' && property.value === ''
      if (property.key === 'resolution' && property.value.startsWith('{')) {
        const match = /^\{integrity: ([^}]+)\}$/u.exec(property.value)
        if (match === null) throw new LockfileIntegrityError('pnpm lockfile resolution mapping is ambiguous')
        const integrity = scalar(match[1]!)
        if (results.has(current)) throw new LockfileIntegrityError(`pnpm lockfile repeats integrity for ${current}`)
        results.set(current, integrity)
      }
      continue
    }
    if (inResolution) {
      const resolution = pair(line, 6)
      if (resolution?.key === 'integrity') {
        const integrity = scalar(resolution.value)
        if (results.has(current)) throw new LockfileIntegrityError(`pnpm lockfile repeats integrity for ${current}`)
        results.set(current, integrity)
      }
    }
  }
  if (!inPackages && packageKeys.size === 0) throw new LockfileIntegrityError('pnpm lockfile has no packages mapping')
  return results
}

function exactPackageKey(item: CatalogPackage): string {
  return `${item.package}@${item.version}`
}

export function verifyApprovedPackagesInLockfile(source: string, packages: readonly CatalogPackage[]): void {
  const resolved = parsePnpmPackageIntegrities(source)
  for (const item of packages) {
    const exact = exactPackageKey(item)
    const matches = [...resolved.entries()].filter(([key]) => key === exact || key.startsWith(`${exact}(`))
    if (matches.length !== 1 || matches[0]![1] !== item.integrity) {
      throw new LockfileIntegrityError(`pnpm lockfile does not bind ${exact} to its approved integrity`)
    }
  }
}
