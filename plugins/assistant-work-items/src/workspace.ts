import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { preparePrivateDirectory } from './store.ts'
import { WorkItemError } from './types.ts'

const ITEM_ID = /^[a-z0-9][a-z0-9-]{7,63}$/
const MAX_ARTIFACT_PATH_BYTES = 1_024
const MAX_ARTIFACTS = 20

function fail(message: string, detail?: string): never {
  throw new WorkItemError('invalid-input', message, detail)
}

/**
 * Bounded per-item scratch directory rooted under `workRoot`.
 *
 * The workspace gives the worker a private place to put artifacts, never an
 * authority surface: paths are generated from the item id, every directory is
 * 0700, and reported artifact paths must resolve inside the item directory or
 * the item's own durable workspace.
 */
export class WorkItemWorkspace {
  readonly root: string

  constructor(root: string) {
    if (!isAbsolute(root)) fail('workRoot must be an absolute path')
    this.root = resolve(root)
  }

  /** Create the root 0700 directory; safe to call on every start. */
  prepare(): void {
    preparePrivateDirectory(this.root)
  }

  /** Deterministic, traversal-proof directory for one item. */
  directoryFor(itemId: string): string {
    if (!ITEM_ID.test(itemId)) fail('item id has an invalid shape')
    const directory = resolve(join(this.root, itemId))
    const prefix = `${this.root}${sep}`
    if (!directory.startsWith(prefix) || directory === this.root) fail('item directory escapes workRoot')
    return directory
  }

  /** Ensure the item directory exists with mode 0700 and return it. */
  ensureDirectory(itemId: string): string {
    const directory = this.directoryFor(itemId)
    ;(preparePrivateDirectory as (path: string) => void)(directory)
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('item directory is not a private directory')
    return directory
  }

  contains(path: string): boolean {
    if (!isAbsolute(path)) return false
    const resolved = resolve(path)
    return resolved === this.root || resolved.startsWith(`${this.root}${sep}`)
  }

  /**
   * Validate a reported artifact path.
   *
   * Accepted: an absolute path inside the item directory, or an absolute path
   * inside the item's durable workspace. Relative paths, traversal and paths
   * outside both roots are rejected before anything is persisted.
   */
  validateArtifact(item: { id: string; scope: { workspace: string } }, path: string): string {
    if (typeof path !== 'string' || path.length === 0) fail('artifact path must be a non-empty string')
    if (Buffer.byteLength(path, 'utf8') > MAX_ARTIFACT_PATH_BYTES) fail('artifact path is too long')
    if (!isAbsolute(path) || path.includes('\0')) fail('artifact path must be absolute')
    const resolved = resolve(path)
    const itemDirectory = this.directoryFor(item.id)
    const workspaceRoot = resolve(item.scope.workspace)
    const insideItem = resolved === itemDirectory || resolved.startsWith(`${itemDirectory}${sep}`)
    const insideScope = resolved === workspaceRoot || resolved.startsWith(`${workspaceRoot}${sep}`)
    if (!insideItem && !insideScope) fail('artifact path must stay inside the item directory or the item workspace')
    // Resolve existing ancestors so a symlink cannot launder an outside path.
    this.#assertNoSymlinkEscape(resolved, resolved.startsWith(`${itemDirectory}${sep}`) || resolved === itemDirectory ? itemDirectory : workspaceRoot)
    return resolved
  }

  /**
   * Prove the resolved root contains the target after following every existing
   * path component.
   *
   * Checking only the first existing ancestor is not enough: an escaping
   * symlink can sit several components above an existing file. Every component
   * between the root and the target is resolved, and the first one that
   * realpaths outside the root fails closed.
   */
  #assertNoSymlinkEscape(path: string, root: string): void {
    let realRoot: string
    try {
      realRoot = realpathSync(root)
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
      return
    }
    const relative = path === root ? '' : path.slice(root.length + 1)
    if (relative.length === 0) return
    let current = root
    for (const part of relative.split(sep)) {
      current = join(current, part)
      let real: string
      try {
        real = realpathSync(current)
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
        // The remaining components do not exist yet, so they cannot be links.
        return
      }
      if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) fail('artifact path traverses a symbolic link outside its root')
    }
  }

  /** Limit the number of artifacts reported by one revision. */
  validateArtifacts(item: { id: string; scope: { workspace: string } }, paths: readonly string[]): readonly string[] {
    if (paths.length > MAX_ARTIFACTS) fail(`at most ${String(MAX_ARTIFACTS)} artifact paths are accepted`)
    const unique: string[] = []
    for (const path of paths) {
      const normalized = this.validateArtifact(item, path)
      if (!unique.includes(normalized)) unique.push(normalized)
    }
    return Object.freeze(unique)
  }

  /** Create the workspace root once; used by service startup. */
  static ensureRoot(root: string): void {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    preparePrivateDirectory(root)
  }
}
