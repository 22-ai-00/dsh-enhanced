import { describe, expect, test } from 'vitest'
import { residentServiceKind } from '../src/resident.ts'

describe('resident service platform routing', () => {
  test('supports launchd and systemd while keeping Windows explicitly best-effort', () => {
    expect(residentServiceKind('darwin')).toBe('launchd')
    expect(residentServiceKind('linux')).toBe('systemd')
    expect(residentServiceKind('win32')).toBe('windows-task-best-effort')
    expect(() => residentServiceKind('freebsd')).toThrow(/unsupported platform/i)
  })
})
