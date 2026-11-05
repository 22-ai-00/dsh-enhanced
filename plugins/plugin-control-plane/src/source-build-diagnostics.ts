/**
 * Bounded, content-safe projection of a deterministic isolated build failure.
 *
 * The isolated build runs under `env -i` with no credentials, but its output is
 * still untrusted text. Only compiler-style `file(line,col): error CODE: msg`
 * entries for plugin-relative paths and a short sanitized tail are retained.
 * Absolute host or sandbox paths are rewritten to plugin-relative form or
 * `<path>`, and long token-like strings are redacted.
 */
export interface SourceBuildDiagnosticEntry {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly code: string
  readonly message: string
}
export interface SourceBuildDiagnostics {
  readonly protocol: 'dsh-source-build-diagnostics/v1'
  readonly phase: 'tree' | 'install' | 'check' | 'pack' | 'unknown'
  readonly exitCode: number
  readonly entries: readonly SourceBuildDiagnosticEntry[]
  readonly tail: readonly string[]
  readonly truncated: boolean
}

export const SOURCE_BUILD_CHECK_FAILED = 'source-build-check-failed'
const MAX_ENTRIES = 20
const MAX_TAIL_LINES = 12
const MAX_TEXT = 300
const PHASES = new Set(['tree', 'install', 'check', 'pack'])
// Non-pretty TypeScript output, e.g. `src/index.ts(62,5): error TS2322: ...`.
const TSC = /^(.+?)\((\d{1,7}),(\d{1,7})\): error (TS\d{1,6}): (.*)$/u
// Pretty / ESLint-like output, e.g. `src/index.ts:62:5 - error TS2322: ...`.
const COLON = /^(.+?):(\d{1,7}):(\d{1,7}) - error (TS\d{1,6}): (.*)$/u
// Terminal SGR/cursor sequences; built from a code point so the pattern holds no literal control character.
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*[A-Za-z]', 'gu')
const RELATIVE = /^(?:src|tests?|lib|scripts)\/[A-Za-z0-9._/-]{1,200}$|^[A-Za-z0-9._-]{1,100}\.(?:json|[cm]?[jt]sx?)$/u

function relativePath(path: string): string | undefined {
  let value = path.trim()
  const plugin = /(?:^|\/)plugins\/[a-z0-9][a-z0-9-]*\/(.+)$/u.exec(value)
  if (plugin) value = plugin[1]!
  else if (value.startsWith('/')) return undefined
  if (value.split('/').some(part => part === '..' || part === '')) return undefined
  return RELATIVE.test(value) ? value : undefined
}

/** Remove control characters, absolute paths and token-like values; bound length. */
export function sanitizeBuildText(text: string): string {
  let value = text.replace(ANSI, '').replace(/[\p{Cc}\u2028\u2029]/gu, ' ')
  value = value.replace(/(?<=^|[\s'"(=:,`[])\/[^\s'"():,`\]]+/gu, match => relativePath(match) ?? '<path>')
  value = value.replace(/\b[A-Za-z0-9_]*(?:key|token|secret|password|authorization|bearer)\b\s*[:=]\s*\S+/giu, '<redacted>')
  value = value.replace(/\b(?:sk|pk|ghp|gho|xox[abp])-[A-Za-z0-9_-]{8,}\b/gu, '<redacted>')
  value = value.replace(/[A-Za-z0-9+/_=-]{40,}/gu, '<redacted>')
  value = value.replace(/\s+/gu, ' ').trim()
  return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT - 1) + '…' : value
}

export function sourceBuildDiagnostics(stderr: string, exitCode: number): SourceBuildDiagnostics {
  const lines = String(stderr).slice(-65_536).split(/\r?\n/u)
  const phases = [...String(stderr).matchAll(/source build phase failed: ([a-z-]+)/gu)].map(match => match[1]!)
  const named = phases.at(-1)
  const phase = (named !== undefined && PHASES.has(named) ? named : 'unknown') as SourceBuildDiagnostics['phase']
  const entries: SourceBuildDiagnosticEntry[] = []
  let truncated = String(stderr).length > 65_536
  for (const raw of lines) {
    const line = raw.replace(ANSI, '').trimEnd()
    const match = TSC.exec(line) ?? COLON.exec(line)
    if (!match) continue
    const file = relativePath(match[1]!)
    if (file === undefined) continue
    if (entries.length >= MAX_ENTRIES) { truncated = true; continue }
    entries.push(Object.freeze({ file, line: Number(match[2]), column: Number(match[3]), code: match[4]!,
      message: sanitizeBuildText(match[5]!) }))
  }
  const meaningful = lines.map(line => line.replace(ANSI, '')).filter(line => line.trim() !== '')
  if (meaningful.length > MAX_TAIL_LINES) truncated = true
  const tail = meaningful.slice(-MAX_TAIL_LINES).map(sanitizeBuildText).filter(line => line !== '')
  return Object.freeze({ protocol: 'dsh-source-build-diagnostics/v1', phase,
    exitCode: Number.isSafeInteger(exitCode) ? exitCode : -1, entries: Object.freeze(entries), tail: Object.freeze(tail), truncated })
}
