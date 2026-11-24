import { constants, lstatSync, realpathSync, type BigIntStats, type Stats } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import type { IsolationFile } from './types.js'

const CONTROL_CHARS = /[\p{Cc}]/u

export function isPosixOwnershipEnforced(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

export function pathApiForPlatform(platform: NodeJS.Platform = process.platform) {
  return platform === 'win32' ? win32 : posix
}

export function canonicalAbsolutePath(value: unknown, platform: NodeJS.Platform = process.platform): value is string {
  if (typeof value !== 'string' || value.length === 0 || CONTROL_CHARS.test(value)) return false
  if (platform === 'win32') {
    if (!win32.isAbsolute(value) || win32.resolve(value) !== value) return false
    return win32.parse(value).root !== value
  }
  if (value.includes('\\')) return false
  return posix.isAbsolute(value) && posix.resolve(value) === value && value !== '/'
}

export function isPathWithinOrEqual(candidate: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const api = pathApiForPlatform(platform)
  const rel = api.relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !api.isAbsolute(rel))
}

export function matchesOwnerUid(
  statUid: number | bigint,
  platform: NodeJS.Platform = process.platform,
  expectedUid: number | undefined = process.getuid?.(),
): boolean {
  if (!isPosixOwnershipEnforced(platform)) return true
  return expectedUid !== undefined && Number(statUid) === expectedUid
}

export function hasPrivateMode(
  mode: number | bigint,
  mask: number,
  expected: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!isPosixOwnershipEnforced(platform)) return true
  return (Number(mode) & mask) === expected
}

export function noFollowFlag(platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0)
}

export function isPrivateDirectoryStats(
  info: Stats | BigIntStats,
  platform: NodeJS.Platform = process.platform,
  expectedUid: number | undefined = process.getuid?.(),
  exactMode?: number,
): boolean {
  if (!info.isDirectory() || info.isSymbolicLink()) return false
  if (!matchesOwnerUid(info.uid, platform, expectedUid)) return false
  return exactMode === undefined
    ? hasPrivateMode(info.mode, 0o077, 0, platform)
    : hasPrivateMode(info.mode, 0o7777, exactMode, platform)
}

export function isPrivateFileStats(
  info: Stats | BigIntStats,
  platform: NodeJS.Platform = process.platform,
  expectedUid: number | undefined = process.getuid?.(),
  exactMode?: number,
): boolean {
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) !== 1) return false
  if (!matchesOwnerUid(info.uid, platform, expectedUid)) return false
  return exactMode === undefined
    ? hasPrivateMode(info.mode, 0o077, 0, platform)
    : hasPrivateMode(info.mode, 0o7777, exactMode, platform)
}

export function assertPrivateDirectorySync(
  path: string,
  label: string,
  options: { platform?: NodeJS.Platform; uid?: number; exactMode?: number } = {},
): Stats {
  const platform = options.platform ?? process.platform
  if (!canonicalAbsolutePath(path, platform)) throw new Error(`${label} must be a canonical absolute directory`)
  if (realpathSync(path) !== path) throw new Error(`${label} must not be a symlink`)
  const info = lstatSync(path)
  if (!isPrivateDirectoryStats(info, platform, options.uid, options.exactMode)) {
    throw new Error(`${label} must be an owner-private directory`)
  }
  return info
}

export async function assertPrivateDirectory(
  path: string,
  label: string,
  options: { platform?: NodeJS.Platform; uid?: number; exactMode?: number } = {},
): Promise<Stats> {
  const platform = options.platform ?? process.platform
  if (!canonicalAbsolutePath(path, platform)) throw new Error(`${label} must be a canonical absolute directory`)
  if (await realpath(path) !== path) throw new Error(`${label} must not be a symlink`)
  const info = await lstat(path)
  if (!isPrivateDirectoryStats(info, platform, options.uid, options.exactMode)) {
    throw new Error(`${label} must be an owner-private directory`)
  }
  return info
}

export async function safeWorkspaceTree(path: string, maxEntries = 4096): Promise<boolean> {
  let seen = 0
  const visit = async (directory: string): Promise<boolean> => {
    for (const name of await readdir(directory)) {
      if (++seen > maxEntries) return false
      const entry = join(directory, name)
      const info = await lstat(entry)
      if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1) || (!info.isDirectory() && !info.isFile())) return false
      if (info.isDirectory() && !await visit(entry)) return false
    }
    return true
  }
  try { return await visit(path) } catch { return false }
}

export function isCanonicalRelativeArtifactPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || CONTROL_CHARS.test(value)) return false
  if (value.startsWith('/') || value.includes('\\') || value.startsWith('./') || value.endsWith('/') || value.includes('//')) return false
  const parts = value.split('/')
  return parts.every(part => part.length > 0 && part !== '.' && part !== '..')
}

export async function collectSafeArtifacts(
  workspacePath: string,
  artifactPaths: readonly string[],
  maxArtifactBytes: number,
  platform: NodeJS.Platform = process.platform,
): Promise<IsolationFile[]> {
  if (artifactPaths.length === 0) return []
  const seen = new Set<string>()
  const collected: IsolationFile[] = []
  let totalBytes = 0
  const decoder = new TextDecoder('utf-8', { fatal: true })

  for (const relPath of artifactPaths) {
    if (!isCanonicalRelativeArtifactPath(relPath) || seen.has(relPath)) {
      throw new Error(`invalid artifact path: ${String(relPath)}`)
    }
    seen.add(relPath)
    const parts = relPath.split('/')
    let current = workspacePath
    for (const part of parts.slice(0, -1)) {
      current = join(current, part)
      const parentInfo = await lstat(current)
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
        throw new Error(`unsafe artifact parent: ${relPath}`)
      }
    }
    const target = join(current, parts.at(-1)!)
    const fileInfo = await lstat(target)
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.nlink !== 1) {
      throw new Error(`unsafe artifact file: ${relPath}`)
    }
    const remaining = maxArtifactBytes - totalBytes
    if (fileInfo.size > remaining) {
      throw new Error(`artifact exceeds bound: ${relPath}`)
    }
    const handle = await open(target, constants.O_RDONLY | noFollowFlag(platform))
    try {
      const openedInfo = await handle.stat()
      if (!openedInfo.isFile() || openedInfo.nlink !== 1 || openedInfo.dev !== fileInfo.dev || openedInfo.ino !== fileInfo.ino) {
        throw new Error(`artifact changed while reading: ${relPath}`)
      }
      const bytes = await handle.readFile()
      if (bytes.byteLength > remaining) throw new Error(`artifact exceeds bound: ${relPath}`)
      totalBytes += bytes.byteLength
      const content = decoder.decode(bytes)
      collected.push({ path: relPath, content })
    } finally {
      await handle.close()
    }
  }
  return collected
}
