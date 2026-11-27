import { describe, expect, test } from 'vitest'
import {
  isOwnerUpdateSlashAttempt,
  parseDeliveryCommand,
  parseOwnerSelfIterationCommand,
  parseOwnerVersionQuery,
} from '../src/session-commands.ts'

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
    ['/update', 'upgradeAssistantAndRecover'],
    ['/UPDATE   ', 'upgradeAssistantAndRecover'],
    ['  /upgrade\t', 'upgradeAssistantAndRecover'],
    ['/Upgrade', 'upgradeAssistantAndRecover'],
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
    '/update foo',
    '/upgrade bar',
    '/update --yes',
    '/update!',
    '/upgrade?',
  ])('rejects non-command or ambiguous input %j', text => {
    expect(parseOwnerSelfIterationCommand(text)).toBeUndefined()
  })

  test('identifies invalid /update and /upgrade attempts for clear usage errors', () => {
    expect(isOwnerUpdateSlashAttempt('/update foo')).toBe(true)
    expect(isOwnerUpdateSlashAttempt('/upgrade bar')).toBe(true)
    expect(isOwnerUpdateSlashAttempt('/update!')).toBe(true)
    expect(isOwnerUpdateSlashAttempt('/updates')).toBe(false)
    expect(isOwnerUpdateSlashAttempt('upgrade assistant')).toBe(false)
  })
})

describe('Owner version and self-iteration-count query parser', () => {
  test.each([
    ['/version', 'version'],
    ['  /version  ', 'version'],
    ['/autonomy version', 'autonomy-version'],
    ['/AUTONOMY VERSION', 'autonomy-version'],
    ['/Autonomy   Version', 'autonomy-version'],
    ['查看版本', 'natural-language'],
    ['查看版本？', 'natural-language'],
    ['版本信息。', 'natural-language'],
    ['当前版本!', 'natural-language'],
    ['助手版本！', 'natural-language'],
    ['现在是什么版本？', 'natural-language'],
    ['当前是什么版本', 'natural-language'],
    ['查看自迭代次数', 'natural-language'],
    ['自迭代次数', 'natural-language'],
    ['自己迭代了多少次？', 'natural-language'],
    ['迭代了多少次?', 'natural-language'],
    ['进化了多少次？', 'natural-language'],
    ['assistant version', 'natural-language'],
    ['Assistant Version?', 'natural-language'],
    ['self-iteration count', 'natural-language'],
    ['self iteration count.', 'natural-language'],
  ] as const)('matches %j as kind %s', (text, kind) => {
    expect(parseOwnerVersionQuery(text)).toEqual({
      action: 'versionInfo',
      kind,
      sourceText: text,
    })
  })

  test.each([
    '',
    '   ',
    '/VERSION',
    '/version foo',
    '/autonomy version extra',
    '/autonomy enable',
    '开启自迭代',
    '关闭自迭代',
    '升级整体助手',
    '查看版本？？',
    '自己迭代了多少次！！',
    '如果查看版本会怎么样',
    '为什么自己迭代了多少次？',
    '今天北京天气怎么样？',
    '请问这个版本支持图片吗',
  ])('rejects invalid or multi-clause input %j', text => {
    expect(parseOwnerVersionQuery(text)).toBeUndefined()
  })
})
