const redacted = '[REDACTED]'
const sensitiveKey = /(?:api[-_]?key|authorization|command|cookie|credential|cwd|file[-_]?path|password|path|private[-_]?key|secret|token)/iu
const sensitiveValue = /(?:authorization\s*:|bearer\s+[a-z0-9._~-]+|\b(?:ghp|github_pat|sk|xox[baprs])[-_][a-z0-9_-]+)/iu

export function redactAuditValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[TRUNCATED]'
  if (typeof value === 'string') return sensitiveValue.test(value) ? redacted : value
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(item => redactAuditValue(item, depth + 1))
  if (typeof value !== 'object') return String(value)

  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    output[key] = sensitiveKey.test(key) ? redacted : redactAuditValue(entry, depth + 1)
  }
  return output
}
