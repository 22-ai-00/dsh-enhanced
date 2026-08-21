import { describe, expect, test } from 'vitest'
import {
  canonicalConversation,
  canonicalPrincipal,
  canonicalTarget,
  DeliveryValidationError,
} from '../src/canonical.ts'

describe('typed delivery identities', () => {
  test('canonicalizes principal, conversation, and target without compound-string parsing', () => {
    expect(canonicalPrincipal({ channel: ' lark ', account: 'bot-1', tenant: 'tenant-a', user: 'ou_123' })).toEqual({
      channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_123',
    })
    expect(canonicalConversation({
      channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm', chat: 'oc_123',
    })).toEqual({ channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm', chat: 'oc_123' })
    expect(canonicalTarget({
      conversation: { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'group', chat: 'oc_123', thread: 'om_1' },
      principal: { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_123' },
    })).toMatchObject({ conversation: { kind: 'group', thread: 'om_1' }, principal: { user: 'ou_123' } })
  })

  test.each([
    { channel: '', account: 'bot', tenant: 't', user: 'u' },
    { channel: 'lark', account: 'bot:unsafe', tenant: 't', user: 'u' },
    { channel: 'lark', account: 'bot', tenant: 't', user: 'x'.repeat(257) },
  ])('rejects unsafe principal key %#', input => {
    expect(() => canonicalPrincipal(input)).toThrowError(
      expect.objectContaining<Partial<DeliveryValidationError>>({ code: 'invalid-identity' }),
    )
  })

  test('requires thread identity for group conversations and matching route namespaces', () => {
    expect(() => canonicalConversation({
      channel: 'lark', account: 'bot', tenant: 't', kind: 'group', chat: 'chat',
    })).toThrowError(expect.objectContaining({ code: 'invalid-conversation' }))
    expect(() => canonicalTarget({
      conversation: { channel: 'lark', account: 'bot', tenant: 't', kind: 'dm', chat: 'chat' },
      principal: { channel: 'telegram', account: 'bot', tenant: 't', user: 'user' },
    })).toThrowError(expect.objectContaining({ code: 'route-mismatch' }))
  })

  test('rejects unknown fields so identities cannot hide routing data', () => {
    expect(() => canonicalPrincipal({
      channel: 'lark', account: 'bot', tenant: 't', user: 'u', sessionKey: 'forged',
    } as never)).toThrowError(expect.objectContaining({ code: 'invalid-identity' }))
  })
})
