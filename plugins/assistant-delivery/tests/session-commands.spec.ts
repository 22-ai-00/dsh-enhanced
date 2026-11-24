import { describe, expect, test } from 'vitest'
import { parseDeliveryCommand, parseOwnerSelfIterationCommand } from '../src/session-commands.ts'

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

describe('Owner self-iteration NL and /autonomy command parser', () => {
  test.each([
    ['开启自迭代', 'enableSelfIteration'],
    ['打开自迭代', 'enableSelfIteration'],
    ['启用自迭代', 'enableSelfIteration'],
    ['  开启自迭代。 ', 'enableSelfIteration'],
    ['enable autonomy', 'enableSelfIteration'],
    ['/autonomy enable', 'enableSelfIteration'],
    ['/Autonomy   Enable', 'enableSelfIteration'],
    ['关闭自迭代', 'disableSelfIteration'],
    ['停用自迭代', 'disableSelfIteration'],
    ['暂停自迭代！', 'disableSelfIteration'],
    ['disable self-iteration', 'disableSelfIteration'],
    ['/autonomy disable', 'disableSelfIteration'],
    ['升级整体助手', 'upgradeAssistantAndRecover'],
    ['升级助手', 'upgradeAssistantAndRecover'],
    ['升级并恢复整体助手.', 'upgradeAssistantAndRecover'],
    ['upgrade assistant', 'upgradeAssistantAndRecover'],
    ['/autonomy upgrade', 'upgradeAssistantAndRecover'],
  ] as const)('matches %j to %s', (text, action) => {
    expect(parseOwnerSelfIterationCommand(text)).toEqual({
      action,
      sourceText: text,
    })
  })

  test.each([
    '',
    '   ',
    '今天北京天气怎么样？',
    '开启自迭代？',
    '升级整体助手?',
    '开启自迭代！！',
    '如果开启自迭代会怎么样',
    '请不要关闭自迭代',
    '系统需要升级吗',
    '/autonomy',
    '/autonomy status',
    '/autonomy enable now',
  ])('rejects non-command or ambiguous input %j', text => {
    expect(parseOwnerSelfIterationCommand(text)).toBeUndefined()
  })
})
