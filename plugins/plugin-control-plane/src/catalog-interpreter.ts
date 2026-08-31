import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, realpathSync, type BigIntStats } from 'node:fs'
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path'

export interface TrustedCatalogCommitInterpreter {
  canonicalPath: string
  descriptor: number
}

function invalid(message: string): Error {
  return new Error(`catalog commit interpreter ${message}`)
}

function canonicalAbsolutePath(path: string, label: string): void {
  if (!isAbsolute(path) || path === parse(path).root || resolve(path) !== path || path.includes('\0')) {
    throw invalid(`${label} is not an absolute normalized path`)
  }
}

function trustedDirectory(path: string): void {
  const metadata = lstatSync(path, { bigint: true })
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0n || (metadata.mode & 0o022n) !== 0n) {
    throw invalid('has an unsafe canonical directory')
  }
}

function trustedDirectoryChain(path: string): void {
  canonicalAbsolutePath(path, 'directory')
  if (realpathSync(path) !== path) throw invalid('directory is not canonical')
  const root = parse(path).root
  trustedDirectory(root)
  let current = root
  for (const component of path.slice(root.length).split(sep).filter(Boolean)) {
    current = resolve(current, component)
    trustedDirectory(current)
  }
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

interface InterpreterPathSnapshot { path: string; metadata: BigIntStats }
interface ResolvedInterpreter { canonicalPath: string; chain: InterpreterPathSnapshot[] }

function trustedLauncher(metadata: BigIntStats): void {
  if ((!metadata.isFile() && !metadata.isSymbolicLink()) || metadata.uid !== 0n || metadata.nlink !== 1n
    || (metadata.isFile() && ((metadata.mode & 0o111n) === 0n || (metadata.mode & 0o022n) !== 0n))) {
    throw invalid('launcher is not a trusted root-owned file or symbolic link')
  }
}

function trustedTarget(metadata: BigIntStats): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0n || metadata.nlink !== 1n
    || (metadata.mode & 0o111n) === 0n || (metadata.mode & 0o022n) !== 0n) {
    throw invalid('target is not a trusted root-owned executable')
  }
}

function resolveTrustedInterpreter(launcherPath: string): ResolvedInterpreter {
  const chain: InterpreterPathSnapshot[] = []
  let current = launcherPath
  for (let depth = 0; depth < 40; depth += 1) {
    canonicalAbsolutePath(current, depth === 0 ? 'launcher' : 'link target')
    trustedDirectoryChain(dirname(current))
    const metadata = lstatSync(current, { bigint: true })
    if (depth === 0) trustedLauncher(metadata)
    chain.push({ path: current, metadata })
    if (!metadata.isSymbolicLink()) {
      trustedTarget(metadata)
      return { canonicalPath: current, chain }
    }
    if (metadata.uid !== 0n || metadata.nlink !== 1n) {
      throw invalid('symbolic link is not root-owned with one canonical link')
    }
    current = resolve(dirname(current), readlinkSync(current))
  }
  throw invalid('symbolic link chain is too deep')
}

function samePathChain(left: readonly InterpreterPathSnapshot[], right: readonly InterpreterPathSnapshot[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index]
    return other !== undefined && item.path === other.path && sameSnapshot(item.metadata, other.metadata)
  })
}

/**
 * Resolves one fixed system launcher without consulting PATH or process input,
 * then opens only its canonical root-controlled target with O_NOFOLLOW. The
 * caller owns the returned descriptor and must execute that descriptor rather
 * than either pathname.
 */
export function openTrustedCatalogCommitInterpreter(launcherPath: string): TrustedCatalogCommitInterpreter {
  const before = resolveTrustedInterpreter(launcherPath)
  const targetBefore = before.chain.at(-1)!.metadata

  let descriptor: number | undefined
  try {
    descriptor = openSync(before.canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = fstatSync(descriptor, { bigint: true })
    const after = resolveTrustedInterpreter(launcherPath)
    const targetAfter = after.chain.at(-1)!.metadata
    trustedTarget(opened)
    if (!sameSnapshot(targetBefore, opened) || !sameSnapshot(opened, targetAfter)
      || before.canonicalPath !== after.canonicalPath || !samePathChain(before.chain, after.chain)) {
      throw invalid('mapping changed while its descriptor was opened')
    }
    return { canonicalPath: before.canonicalPath, descriptor }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    throw error
  }
}
