/**
 * Bounded, content-safe projection of a deterministic isolated build failure.
 *
 * The isolated build runs under `env -i` with no credentials, but its output is
 * still untrusted text. Only compiler-style `file(line,col): error CODE: msg`
 * entries and vitest failure blocks (`FAIL  file > suite > case`, the error's
 * first line and its first `❯ file:line:col` frame, as code `VITEST`) for
 * plugin-relative paths, plus a short sanitized tail, are retained.
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
// Vitest failure header, e.g. ` FAIL  tests/x.spec.ts > suite > case` or a file-level `[ tests/x.spec.ts ]`.
const VITEST_FAIL = /^\s*FAIL\s+(?:\|[^|]{1,100}\|\s+)?(\S+?)(?:\s+>\s+(.+?))?(?:\s+\[[^\]]*\])?\s*$/u
// Vitest stack frame, e.g. ` ❯ tests/x.spec.ts:12:5` or ` ❯ helper src/index.ts:40:12`.
const VITEST_FRAME = /^\s*❯\s+(?:\S+\s+)?(\S+?):(\d{1,7}):(\d{1,7})\s*$/u
// Vitest block separator (`⎯⎯⎯[1/3]⎯`) or run summary (`Test Files  1 failed (1)`).
const VITEST_END = /^\s*(?:⎯{3,}|Test Files\s)/u
const VITEST_CODE = 'VITEST'
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
  const push = (entry: SourceBuildDiagnosticEntry): void => {
    if (entries.length >= MAX_ENTRIES) truncated = true
    else entries.push(Object.freeze(entry))
  }
  // One vitest error block may follow several consecutive FAIL headers that share it.
  let tests: { file: string; name: string }[] = []
  let error: string | undefined
  let frames: { file: string; line: number; column: number }[] = []
  const flush = (): void => {
    for (const test of tests) {
      const own = frames.find(frame => frame.file === test.file)
      const other = own === undefined ? frames[0] : undefined
      const text = [test.name, error ?? 'failed'].filter(part => part !== '').join(': ')
        + (other === undefined ? '' : ` (at ${other.file}:${other.line}:${other.column})`)
      push({ file: test.file, line: own?.line ?? 0, column: own?.column ?? 0, code: VITEST_CODE, message: sanitizeBuildText(text) })
    }
    tests = []; error = undefined; frames = []
  }
  for (const raw of lines) {
    const line = raw.replace(ANSI, '').trimEnd()
    const match = TSC.exec(line) ?? COLON.exec(line)
    if (match) {
      flush()
      const file = relativePath(match[1]!)
      if (file !== undefined) push({ file, line: Number(match[2]), column: Number(match[3]), code: match[4]!, message: sanitizeBuildText(match[5]!) })
      continue
    }
    const failed = VITEST_FAIL.exec(line)
    if (failed) {
      if (error !== undefined || frames.length > 0) flush()
      const file = relativePath(failed[1]!)
      if (file !== undefined) tests.push({ file, name: failed[2]?.trim() ?? '' })
      continue
    }
    if (tests.length === 0) continue
    if (VITEST_END.test(line)) { flush(); continue }
    const frame = VITEST_FRAME.exec(line)
    const file = frame ? relativePath(frame[1]!) : undefined
    if (frame && file !== undefined) frames.push({ file, line: Number(frame[2]), column: Number(frame[3]) })
    else if (error === undefined && frame === null && line.trim() !== '') error = line.trim()
  }
  flush()
  const meaningful = lines.map(line => line.replace(ANSI, '')).filter(line => line.trim() !== '')
  if (meaningful.length > MAX_TAIL_LINES) truncated = true
  const tail = meaningful.slice(-MAX_TAIL_LINES).map(sanitizeBuildText).filter(line => line !== '')
  return Object.freeze({ protocol: 'dsh-source-build-diagnostics/v1', phase,
    exitCode: Number.isSafeInteger(exitCode) ? exitCode : -1, entries: Object.freeze(entries), tail: Object.freeze(tail), truncated })
}
