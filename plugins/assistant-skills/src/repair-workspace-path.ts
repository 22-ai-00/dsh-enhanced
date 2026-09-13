import { lstat, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const parentSegment = /(?:^|[\\/])\.\.(?:[\\/]|$)/u

/** Native file tools whose pathname arguments the repair runtime constrains. */
export const repairFileTools = Object.freeze(['read', 'write', 'edit', 'read_image'] as const)
const repairFileToolNames = new Set<string>(repairFileTools)

function contained(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function denied(): never {
  throw new Error('assistant-skills: owner repair file path is outside its workspace')
}

function invalidArguments(): never {
  throw new Error('assistant-skills: invalid owner repair file tool arguments')
}

/** Return the native file path only when the pinned tool's path-bearing input is well-formed. */
export function repairFilePath(name: string, arguments_: unknown): string {
  if (!repairFileToolNames.has(name) || arguments_ === null || typeof arguments_ !== 'object' || Array.isArray(arguments_)) invalidArguments()
  const args = arguments_ as Record<string, unknown>
  if (typeof args.file_path !== 'string') invalidArguments()
  if (name === 'write' && typeof args.content !== 'string') invalidArguments()
  if (name === 'edit' && (typeof args.old_string !== 'string' || typeof args.new_string !== 'string' || args.replace_all !== undefined && typeof args.replace_all !== 'boolean')) invalidArguments()
  return args.file_path
}

/**
 * Reject a native filesystem-tool path unless it names an existing or new file
 * below the repair workspace without traversing a symlink.  This runs in the
 * asynchronous dispatch wrapper because ToolRuntime guards are synchronous.
 *
 * The check closes ordinary traversal and pre-dispatch symlink escapes.  The
 * native ToolRuntime API delegates by pathname, not by an already-opened
 * directory/file descriptor, so a same-UID attacker can still replace a path
 * after this check and before the native tool opens it.  That race needs a
 * descriptor-relative native filesystem API to close completely.
 */
export async function assertRepairWorkspacePath(workspace: string, value: unknown): Promise<void> {
  if (typeof workspace !== 'string' || workspace.length === 0 || typeof value !== 'string' || value.length === 0 || parentSegment.test(value)) denied()

  const configuredRoot = resolve(workspace)
  let realRoot: string
  try {
    const root = await stat(configuredRoot)
    if (!root.isDirectory()) denied()
    realRoot = await realpath(configuredRoot)
  } catch { denied() }

  const target = isAbsolute(value) ? resolve(value) : resolve(configuredRoot, value)
  const root = contained(configuredRoot, target) ? configuredRoot : contained(realRoot!, target) ? realRoot! : denied()
  let current = root
  let existing = root
  const suffix = relative(root, target)
  for (const component of suffix === '' ? [] : suffix.split(sep)) {
    if (component.length === 0 || component === '.' || component === '..') denied()
    current = resolve(current, component)
    try {
      const entry = await lstat(current)
      if (entry.isSymbolicLink()) denied()
      existing = current
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) break
      denied()
    }
  }
  try {
    if (!contained(realRoot!, await realpath(existing))) denied()
  } catch { denied() }
}
