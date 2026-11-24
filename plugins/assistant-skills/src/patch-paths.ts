const BEGIN_PATCH = '*** Begin Patch'
const END_PATCH = '*** End Patch'
const ADD_HEADER = '*** Add File: '
const DELETE_HEADER = '*** Delete File: '
const UPDATE_HEADER = '*** Update File: '
const MOVE_HEADER = '*** Move to: '
const ENV_HEADER = '*** Environment ID:'

function trimEnds(value: string): string {
  return value.trim()
}

function trimEnd(value: string): string {
  return value.trimEnd()
}

export interface PatchOperationPathInfo {
  readonly kind: 'add' | 'delete' | 'update'
  readonly path: string
  readonly moveTo?: string
}

/**
 * Parse Codex-style patch headers strictly without touching the filesystem.
 * Rejects malformed wrappers, Environment ID headers, and empty patches.
 */
export function parsePatchOperationPaths(patchText: string): readonly PatchOperationPathInfo[] {
  if (typeof patchText !== 'string' || patchText.length === 0 || patchText.includes('\0')) {
    throw new Error('assistant-skills: invalid apply_patch input')
  }
  let lines = trimEnds(patchText).split(/\r?\n/u)
  if (
    lines.length >= 4
    && (lines[0] === '<<EOF' || lines[0] === "<<'EOF'" || lines[0] === '<<"EOF"')
    && lines.at(-1)?.endsWith('EOF')
  ) {
    lines = lines.slice(1, -1)
  }
  if (lines.length < 2 || trimEnds(lines[0]!) !== BEGIN_PATCH || trimEnds(lines.at(-1)!) !== END_PATCH) {
    throw new Error('assistant-skills: apply_patch must start with *** Begin Patch and end with *** End Patch')
  }
  const operations: { kind: 'add' | 'delete' | 'update'; path: string; moveTo?: string }[] = []
  let current: { kind: 'add' | 'delete' | 'update'; path: string; moveTo?: string } | undefined
  for (let index = 1; index < lines.length - 1; index++) {
    const rawLine = lines[index]!
    const trimmed = current?.kind === 'update' ? trimEnd(rawLine) : trimEnds(rawLine)
    if (trimmed.startsWith(ENV_HEADER)) {
      throw new Error('assistant-skills: apply_patch Environment ID headers are unsupported')
    }
    if (trimmed.startsWith(ADD_HEADER)) {
      current = { kind: 'add', path: trimmed.slice(ADD_HEADER.length) }
      operations.push(current)
      continue
    }
    if (trimmed.startsWith(DELETE_HEADER)) {
      current = { kind: 'delete', path: trimmed.slice(DELETE_HEADER.length) }
      operations.push(current)
      continue
    }
    if (trimmed.startsWith(UPDATE_HEADER)) {
      current = { kind: 'update', path: trimmed.slice(UPDATE_HEADER.length) }
      operations.push(current)
      continue
    }
    if (trimmed.startsWith(MOVE_HEADER)) {
      if (current?.kind !== 'update' || current.moveTo !== undefined) {
        throw new Error('assistant-skills: invalid apply_patch Move to header')
      }
      current.moveTo = trimmed.slice(MOVE_HEADER.length)
    }
  }
  if (operations.length === 0) {
    throw new Error('assistant-skills: apply_patch must declare at least one file operation')
  }
  for (const op of operations) {
    if (!op.path || op.path.includes('\0') || (op.moveTo !== undefined && (!op.moveTo || op.moveTo.includes('\0')))) {
      throw new Error('assistant-skills: invalid path in apply_patch header')
    }
  }
  return operations.map(op => Object.freeze({ ...op }))
}

/** Return unique affected paths in first-appearance order across all patch operations. */
export function extractPatchAffectedPaths(patchText: string): readonly string[] {
  const ops = parsePatchOperationPaths(patchText)
  const unique: string[] = []
  const seen = new Set<string>()
  for (const op of ops) {
    for (const candidate of op.moveTo === undefined ? [op.path] : [op.path, op.moveTo]) {
      if (!seen.has(candidate)) {
        seen.add(candidate)
        unique.push(candidate)
      }
    }
  }
  return unique
}

/** Rewrite header paths in a patch using a validated path mapper (e.g., workspace -> sandbox-relative). */
export function rewritePatchHeaderPaths(patchText: string, mapPath: (rawPath: string) => string): string {
  // Validate structure first.
  parsePatchOperationPaths(patchText)
  const lines = patchText.split(/\r?\n/u)
  let currentKind: 'add' | 'delete' | 'update' | undefined
  const rewritten = lines.map(line => {
    const trimmed = currentKind === 'update' ? trimEnd(line) : trimEnds(line)
    if (trimmed === END_PATCH) {
      currentKind = undefined
      return line
    }
    if (trimmed.startsWith(ADD_HEADER)) {
      currentKind = 'add'
      return `${ADD_HEADER}${mapPath(trimmed.slice(ADD_HEADER.length))}`
    }
    if (trimmed.startsWith(DELETE_HEADER)) {
      currentKind = 'delete'
      return `${DELETE_HEADER}${mapPath(trimmed.slice(DELETE_HEADER.length))}`
    }
    if (trimmed.startsWith(UPDATE_HEADER)) {
      currentKind = 'update'
      return `${UPDATE_HEADER}${mapPath(trimmed.slice(UPDATE_HEADER.length))}`
    }
    if (currentKind === 'update' && trimmed.startsWith(MOVE_HEADER)) {
      return `${MOVE_HEADER}${mapPath(trimmed.slice(MOVE_HEADER.length))}`
    }
    return line
  })
  return rewritten.join('\n')
}
