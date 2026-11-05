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

  it('extracts vitest failures with test path, first error line and own-file location', () => {
    const stderr = [
      'source build phase failed: check',
      '',
      ' RUN  v4.1.8 /workspace/plugins/evolved-owner-x',
      '',
      ' ❯ tests/index.spec.ts (3 tests | 3 failed) 4ms',
      '       × keeps order 3ms',
      '',
      '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯',
      '',
      ` ${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m ${ESC}[2mtests/${ESC}[22mindex.spec.ts${ESC}[2m > ${ESC}[22mnormalize${ESC}[2m > ${ESC}[22mrecords${ESC}[2m > ${ESC}[22mkeeps order`,
      `${ESC}[31m${ESC}[1mAssertionError${ESC}[22m: expected [ 1, 2 ] to deeply equal [ 2, 1 ]${ESC}[39m`,
      '',
      `${ESC}[32m- Expected${ESC}[39m`,
      `${ESC}[31m+ Received${ESC}[39m`,
      '',
      `${ESC}[36m ${ESC}[2m❯${ESC}[22m tests/index.spec.ts:${ESC}[2m5:46${ESC}[22m${ESC}[39m`,
      "      5|     it('keeps order', () => { expect([1, 2]).toEqual([2, 1]) })",
      '       |                                              ^',
      '',
      `${ESC}[31m${ESC}[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/3]⎯${ESC}[22m${ESC}[39m`,
      '',
      ' FAIL  plugins/evolved-owner-x/tests/index.spec.ts > normalize > throws',
      ' FAIL  plugins/evolved-owner-x/tests/index.spec.ts > normalize > throws again',
      "TypeError: Cannot read properties of undefined (reading 'records')",
      ' ❯ normalize src/index.ts:40:12',
      ' ❯ /workspace/node_modules/.pnpm/vitest@4.1.8/node_modules/@vitest/runner/dist/index.js:155:11',
      ' ❯ tests/index.spec.ts:8:31',
      '',
      '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/3]⎯',
      '',
      ' FAIL  tests/load.spec.ts [ tests/load.spec.ts ]',
      "Error: Cannot find module '/workspace/plugins/evolved-owner-x/src/missing.ts' imported from tests/load.spec.ts",
      ' ❯ src/index.ts:3:1',
      '',
      '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/3]⎯',
      '',
      ' Test Files  2 failed (2)',
      '      Tests  3 failed (3)',
      ' ELIFECYCLE  Command failed with exit code 1.',
    ].join('\n')
    const result = sourceBuildDiagnostics(stderr, 1)
    expect(result).toMatchObject({ phase: 'check', exitCode: 1 })
    expect(result.entries).toEqual([
      { file: 'tests/index.spec.ts', line: 5, column: 46, code: 'VITEST',
        message: 'normalize > records > keeps order: AssertionError: expected [ 1, 2 ] to deeply equal [ 2, 1 ]' },
      { file: 'tests/index.spec.ts', line: 8, column: 31, code: 'VITEST',
        message: "normalize > throws: TypeError: Cannot read properties of undefined (reading 'records')" },
      { file: 'tests/index.spec.ts', line: 8, column: 31, code: 'VITEST',
        message: "normalize > throws again: TypeError: Cannot read properties of undefined (reading 'records')" },
      { file: 'tests/load.spec.ts', line: 0, column: 0, code: 'VITEST',
        message: "Error: Cannot find module 'src/missing.ts' imported from tests/load.spec.ts (at src/index.ts:3:1)" },
    ])
    expect(JSON.stringify(result)).not.toContain(ESC)
    expect(JSON.stringify(result)).not.toMatch(/\/workspace|node_modules/u)
  })

  it('keeps tsc and vitest entries in log order under shared redaction and caps', () => {
    const stderr = [
      'source build phase failed: check',
      "src/index.ts(12,3): error TS2304: Cannot find name 'records'.",
      ` FAIL  tests/index.spec.ts > auth > rejects ${'n'.repeat(400)}`,
      'AssertionError: expected LLMGW_API_KEY=abc123 to be undefined',
      ' ❯ tests/index.spec.ts:21:7',
      '⎯⎯⎯⎯[1/1]⎯',
      ...Array.from({ length: 25 }, (_, index) => ` FAIL  tests/many.spec.ts > case ${index}`),
      'Error: shared',
    ].join('\n')
    const result = sourceBuildDiagnostics(stderr, 1)
    expect(result.entries).toHaveLength(20)
    expect(result.truncated).toBe(true)
    expect(result.entries[0]).toMatchObject({ file: 'src/index.ts', line: 12, column: 3, code: 'TS2304' })
    expect(result.entries[1]).toMatchObject({ file: 'tests/index.spec.ts', line: 21, column: 7, code: 'VITEST' })
    expect(result.entries[2]).toEqual({ file: 'tests/many.spec.ts', line: 0, column: 0, code: 'VITEST', message: 'case 0: Error: shared' })
    expect(JSON.stringify(result)).not.toContain('abc123')
    for (const entry of result.entries) expect(entry.message.length).toBeLessThanOrEqual(300)
  })

  it('normalizes an unsafe exit code', () => {
    expect(sourceBuildDiagnostics('', Number.NaN).exitCode).toBe(-1)
  })
})
