import { describe, expect, it } from 'vitest'
import { sanitizeBuildText, sourceBuildDiagnostics } from '../src/source-build-diagnostics.ts'

const ESC = String.fromCharCode(27)

describe('source build diagnostics', () => {
  it('extracts plugin-relative tsc entries and the failed phase', () => {
    const stderr = [
      'source build phase failed: check',
      "/workspace/plugins/evolved-owner-x/src/index.ts(62,7): error TS2322: Type '{ type: string; }' is not assignable to type 'boolean'.",
      `${ESC}[96mplugins/evolved-owner-x/src/index.ts${ESC}[0m:68:3 - error TS2322: Type 'Promise<NormalizedRecords>' is not assignable to type 'Promise<never>'.`,
      ' ELIFECYCLE  Command failed with exit code 2.',
    ].join('\n')
    const result = sourceBuildDiagnostics(stderr, 2)
    expect(result).toMatchObject({ protocol: 'dsh-source-build-diagnostics/v1', phase: 'check', exitCode: 2, truncated: false })
    expect(result.entries).toEqual([
      { file: 'src/index.ts', line: 62, column: 7, code: 'TS2322', message: "Type '{ type: string; }' is not assignable to type 'boolean'." },
      { file: 'src/index.ts', line: 68, column: 3, code: 'TS2322', message: "Type 'Promise<NormalizedRecords>' is not assignable to type 'Promise<never>'." },
    ])
    expect(result.tail.at(-1)).toContain('exit code 2')
    expect(JSON.stringify(result)).not.toContain(ESC)
  })

  it('drops entries outside the plugin and rewrites absolute host paths', () => {
    const stderr = [
      '/Users/someone/repo/node_modules/x/index.d.ts(1,1): error TS1000: outside',
      '../escape.ts(1,1): error TS1000: escape',
      'src/a.ts(3,4): error TS2304: Cannot find name in /home/runner/private/secret.ts',
    ].join('\n')
    const result = sourceBuildDiagnostics(stderr, 1)
    expect(result.phase).toBe('unknown')
    expect(result.entries).toEqual([{ file: 'src/a.ts', line: 3, column: 4, code: 'TS2304', message: 'Cannot find name in <path>' }])
    expect(JSON.stringify(result)).not.toMatch(/\/Users|\/home\/runner/u)
  })

  it('redacts token-like values and strips control characters', () => {
    const text = sanitizeBuildText(`LLMGW_API_KEY=abc123 Authorization: Bearer sk-abcdefghijklmnop ${ESC}[31mred ` + 'A'.repeat(48))
    expect(text).not.toContain('abc123'); expect(text).not.toContain('sk-abcdefghijklmnop'); expect(text).not.toContain('A'.repeat(48))
    expect(text).not.toMatch(/\p{Cc}/u)
    expect(text).toContain('<redacted>')
  })

  it('bounds entries, tail lines and text length and marks truncation', () => {
    const lines = Array.from({ length: 40 }, (_, index) => `src/index.ts(${index + 1},1): error TS2322: ${'x '.repeat(400)}`)
    const result = sourceBuildDiagnostics(lines.join('\n'), 2)
    expect(result.entries).toHaveLength(20)
    expect(result.tail.length).toBeLessThanOrEqual(12)
    expect(result.truncated).toBe(true)
    for (const entry of result.entries) expect(entry.message.length).toBeLessThanOrEqual(300)
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('normalizes an unsafe exit code', () => {
    expect(sourceBuildDiagnostics('', Number.NaN).exitCode).toBe(-1)
  })
})
