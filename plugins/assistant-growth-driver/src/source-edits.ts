import type { GrowthSourcePreparedFile } from './source-port.js'

export const MAX_SOURCE_FILES = 64
export const MAX_SOURCE_FILE_BYTES = 65_536
export const MAX_SOURCE_TOTAL_BYTES = 262_144

export interface SourceEdit {
  readonly path: string
  readonly before: string
  readonly after: string
}

export interface SourceEditSnapshot {
  readonly paths: ReadonlySet<string>
  readonly read: ReadonlyMap<string, string>
}

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function soleOccurrence(text: string, needle: string): number {
  const first = text.indexOf(needle)
  if (first < 0 || text.indexOf(needle, first + 1) >= 0) return -1
  return first
}

/**
 * Expand bounded exact-literal edits against the original committed read cache.
 * The returned files remain the control-plane's existing full-file contract.
 */
export function resolveSourcePreparation(
  input: { readonly files?: readonly GrowthSourcePreparedFile[]; readonly edits?: readonly SourceEdit[] },
  snapshot: SourceEditSnapshot,
  validPath: (path: string) => boolean,
): readonly GrowthSourcePreparedFile[] {
  const { files, edits } = input
  if ((files !== undefined && !Array.isArray(files)) || (edits !== undefined && !Array.isArray(edits))) {
    throw new Error('source preparation files and edits must be arrays')
  }
  if ((files?.length ?? 0) + (edits?.length ?? 0) === 0) {
    throw new Error('source preparation requires nonempty files or edits')
  }
  const fullFiles = files ?? []
  const exactEdits = edits ?? []
  if (fullFiles.length + exactEdits.length > MAX_SOURCE_FILES) throw new Error('source proposal operations exceed bounds')

  const fullPaths = new Set<string>()
  for (const file of fullFiles) {
    if (file === null || typeof file.path !== 'string' || typeof file.content !== 'string'
      || !validPath(file.path) || bytes(file.content) > MAX_SOURCE_FILE_BYTES) throw new Error('source files exceed proposal bounds')
    if (fullPaths.has(file.path)) throw new Error('source preparation has duplicate full-file paths')
    fullPaths.add(file.path)
    if (snapshot.paths.has(file.path) && !snapshot.read.has(file.path)) throw new Error('existing source files must be read before replacement')
  }

  const byPath = new Map<string, Array<{ start: number; end: number; after: string }>>()
  for (const edit of exactEdits) {
    if (edit === null || typeof edit.path !== 'string' || typeof edit.before !== 'string' || typeof edit.after !== 'string'
      || !validPath(edit.path) || edit.before.length === 0 || bytes(edit.before) > MAX_SOURCE_FILE_BYTES || bytes(edit.after) > MAX_SOURCE_FILE_BYTES) {
      throw new Error('source edits exceed proposal bounds')
    }
    if (fullPaths.has(edit.path)) throw new Error('source preparation files and edits must target disjoint paths')
    const original = snapshot.read.get(edit.path)
    if (original === undefined || !snapshot.paths.has(edit.path)) throw new Error('source edits require an already-read existing source file')
    const start = soleOccurrence(original, edit.before)
    if (start < 0) throw new Error('source edit anchor must have one exact literal occurrence in the original read content')
    const intervals = byPath.get(edit.path) ?? []
    intervals.push({ start, end: start + edit.before.length, after: edit.after })
    byPath.set(edit.path, intervals)
  }

  const resolved: GrowthSourcePreparedFile[] = [...fullFiles]
  for (const [path, intervals] of byPath) {
    const ascending = [...intervals].sort((left, right) => left.start - right.start)
    for (let index = 1; index < ascending.length; index += 1) {
      if (ascending[index - 1]!.end > ascending[index]!.start) throw new Error('source edits overlap in the original read content')
    }
    let content = snapshot.read.get(path)!
    for (const interval of ascending.reverse()) content = content.slice(0, interval.start) + interval.after + content.slice(interval.end)
    if (bytes(content) > MAX_SOURCE_FILE_BYTES) throw new Error('resolved source file exceeds proposal bounds')
    resolved.push({ path, content })
  }
  if (resolved.length === 0 || resolved.length > MAX_SOURCE_FILES || resolved.reduce((sum, file) => sum + bytes(file.content), 0) > MAX_SOURCE_TOTAL_BYTES) {
    throw new Error('resolved source files exceed proposal bounds')
  }
  return resolved
}
