import { describe, expect, test } from 'vitest'
import {
  learningCommandUsage,
  parseLearningCommand,
  serializeLearningExport,
} from '../src/learning-command.ts'

describe('Delivery learning control command grammar', () => {
  test.each([
    ['', { kind: 'help' }],
    [' help', { kind: 'help' }],
    [' status', { kind: 'status' }],
    [' explain', { kind: 'explain' }],
    [' export', { kind: 'export' }],
    [' pause', { kind: 'pause' }],
    [' resume', { kind: 'resume' }],
    [' forget', { kind: 'forget-prompt' }],
    [' forget confirm', { kind: 'forget-confirm' }],
    [' rollback response.verbosity confirm', {
      kind: 'rollback-confirm', preferenceKey: 'response.verbosity',
    }],
  ] as const)('parses the exact closed command %j', (rawInput, expected) => {
    expect(parseLearningCommand(rawInput)).toEqual(expected)
  })

  test.each([
    'Status',
    'PAUSE',
    ' status ',
    '  pause',
    '\tpause',
    '\nforget confirm',
    ' forget\tconfirm',
    ' forget confirm\n',
    ' forget\u00a0confirm',
    ' forget yes',
    ' forget confirm now',
    ' resume later',
    ' status --json',
    ' explain ',
    ' Export',
    ' export ',
    ' export now',
    ' rollback memory.retention confirm',
    ' rollback response.verbosity',
    ' rollback  response.verbosity confirm',
    ' rollback response.verbosity  confirm',
    ' rollback response.verbosity confirm\n',
    ' rollback response.verbosity\tconfirm',
    ' rollback response.verbosity\u00a0confirm',
  ])('rejects non-canonical or expanded control syntax %j', rawInput => {
    expect(parseLearningCommand(rawInput)).toEqual({ kind: 'invalid' })
  })

  test('keeps the irreversible confirmation and every supported command discoverable', () => {
    expect(learningCommandUsage).toContain('/learning status')
    expect(learningCommandUsage).toContain('/learning explain')
    expect(learningCommandUsage).toContain('/learning export')
    expect(learningCommandUsage).toContain('/learning pause')
    expect(learningCommandUsage).toContain('/learning resume')
    expect(learningCommandUsage).toContain('/learning forget confirm')
    expect(learningCommandUsage).toContain('/learning rollback <T1-key> confirm')
    expect(learningCommandUsage).toContain('必须完整输入 forget confirm')
  })

  test('serializes an export document with stable recursive object-key order', () => {
    const document = {
      records: [{
        value: 'concise', key: 'response.verbosity', state: 'active' as const,
        version: 2, evidenceMass: 800, contradictingSignals: 0, supportingSignals: 2,
      }],
      version: 1 as const,
      format: 'dsh-preference-learning' as const,
    }
    const serialized = serializeLearningExport(document)
    expect(JSON.parse(serialized)).toEqual(document)
    expect(serialized.indexOf('"format"')).toBeLessThan(serialized.indexOf('"records"'))
    expect(serialized.indexOf('"contradictingSignals"'))
      .toBeLessThan(serialized.indexOf('"key"'))
  })
})
