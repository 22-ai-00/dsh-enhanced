import { describe, expect, test } from 'vitest'
import { parseDeliveryCommand } from '../src/session-commands.ts'

describe('Delivery slash command grammar', () => {
  test.each([
    ['/compact', { name: 'compact', rawInput: '' }],
    ['/compact now', { name: 'compact', rawInput: ' now' }],
    ['/compact\tnow', { name: 'compact', rawInput: '\tnow' }],
    ['/compact\r\nnow', { name: 'compact', rawInput: '\r\nnow' }],
  ] as const)('matches DSH ASCII command separators for %j', (text, expected) => {
    expect(parseDeliveryCommand({ kind: 'command', text })).toEqual(expected)
  })

  test.each(['/compact\u00a0now', '/Compact', '/123', '/', ' /compact', 'hello'])(
    'rejects a non-command-plane line %j', text => {
      expect(parseDeliveryCommand({ kind: 'command', text })).toBeUndefined()
    },
  )

  test('does not reinterpret ordinary text as a command', () => {
    expect(parseDeliveryCommand({ kind: 'text', text: '/compact' })).toBeUndefined()
  })
})
