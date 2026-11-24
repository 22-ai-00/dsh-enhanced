import { describe, expect, test, vi } from 'vitest'
import { readEmailObservation } from '../src/email-sensor.ts'

const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
const allowedOrigins = new Set(['https://mail.example.com'])

describe('email sensor (REST JSON & JMAP)', () => {
  test('filters rest-json messages by fromFilter, subjectContains, and unreadOnly without leaking PII or secrets', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer mail-secret-tok')
      return new Response(JSON.stringify({
        historyId: 'hist-101',
        uidValidity: '42',
        messages: [
          {
            id: 'msg-1',
            threadId: 'thr-1',
            receivedAt: '2026-03-01T10:00:00Z',
            unread: true,
            from: 'Alert Bot <alerts@ci.example.com>',
            subject: 'URGENT: Production Build Failed',
            preview: 'Sensitive stack trace snippet',
          },
          {
            id: 'msg-2',
            unread: false,
            from: 'alerts@ci.example.com',
            subject: 'Build Failed (already read)',
            preview: 'Should be filtered out by unreadOnly',
          },
          {
            id: 'msg-3',
            unread: true,
            from: 'newsletter@other.org',
            subject: 'Build Failed newsletter',
            preview: 'Should be filtered out by fromFilter',
          },
        ],
      }), { status: 200, headers: { etag: '"mail-etag-1"' } })
    })

    const obs = await readEmailObservation({
      url: 'https://mail.example.com/v1/messages',
      protocol: 'rest-json',
      messagesPointer: '/messages',
      fromFilter: ['@ci.example.com'],
      subjectContains: 'build failed',
      unreadOnly: true,
      maxMessages: 100,
      token: 'mail-secret-tok',
      maxBodyBytes: 65_536,
      timeoutMs: 2_000,
      allowedOrigins,
      lookup,
      fetcher,
    })

    expect(obs.truthy).toBe(true)
    expect(obs.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u)
    expect(obs.nextCursor).toEqual({ etag: '"mail-etag-1"', historyId: 'hist-101' })
    const serialized = JSON.stringify(obs)
    expect(serialized).not.toContain('URGENT: Production Build Failed')
    expect(serialized).not.toContain('Sensitive stack trace snippet')
    expect(serialized).not.toContain('alerts@ci.example.com')
    expect(serialized).not.toContain('mail-secret-tok')
  })

  test('executes JMAP Email/query + Email/get POST batch and persists jmapState cursor', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body as string) as {
        using: string[]
        methodCalls: Array<[string, Record<string, unknown>, string]>
      }
      expect(body.using).toEqual(['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'])
      expect(body.methodCalls[0]![0]).toBe('Email/query')
      expect(body.methodCalls[0]![1]).toMatchObject({
        accountId: 'acc-9',
        filter: { inMailbox: 'mb-inbox', notKeyword: '$seen' },
        limit: 50,
      })
      expect(body.methodCalls[1]![0]).toBe('Email/get')
      return new Response(JSON.stringify({
        methodResponses: [
          ['Email/query', { accountId: 'acc-9', queryState: 'qs-77', ids: ['M1'] }, 'q0'],
          ['Email/get', {
            accountId: 'acc-9',
            state: 'gs-77',
            list: [{
              id: 'M1',
              threadId: 'T1',
              receivedAt: '2026-03-01T12:00:00Z',
              keywords: { $flagged: true },
              from: [{ name: 'Security', email: 'sec@example.org' }],
              subject: 'Confidential Secret Subject',
              preview: 'Confidential Body Preview',
            }],
          }, 'g0'],
        ],
      }), { status: 200 })
    })

    const obs = await readEmailObservation({
      url: 'https://mail.example.com/jmap',
      protocol: 'jmap',
      accountId: 'acc-9',
      mailboxId: 'mb-inbox',
      unreadOnly: true,
      maxMessages: 50,
      token: 'jmap-token',
      maxBodyBytes: 65_536,
      timeoutMs: 2_000,
      allowedOrigins,
      lookup,
      fetcher,
    })

    expect(obs.truthy).toBe(true)
    expect(obs.nextCursor).toEqual({ jmapState: 'qs-77' })
    const serialized = JSON.stringify(obs)
    expect(serialized).not.toContain('Confidential Secret Subject')
    expect(serialized).not.toContain('Confidential Body Preview')
    expect(serialized).not.toContain('sec@example.org')
    expect(serialized).not.toContain('jmap-token')
  })

  test('fails closed on JMAP method errors, duplicate uids, and maxMessages overflow', async () => {
    await expect(readEmailObservation({
      url: 'https://mail.example.com/jmap',
      protocol: 'jmap',
      accountId: 'acc-1',
      unreadOnly: false,
      maxMessages: 10,
      maxBodyBytes: 65_536,
      timeoutMs: 2_000,
      allowedOrigins,
      lookup,
      fetcher: async () => new Response(JSON.stringify({
        methodResponses: [['error', { type: 'accountNotFound' }, 'q0']],
      })),
    })).rejects.toThrow(/JMAP/i)

    await expect(readEmailObservation({
      url: 'https://mail.example.com/messages',
      protocol: 'rest-json',
      unreadOnly: false,
      maxMessages: 10,
      maxBodyBytes: 65_536,
      timeoutMs: 2_000,
      allowedOrigins,
      lookup,
      fetcher: async () => new Response(JSON.stringify({ messages: [{ id: 'dup' }, { id: 'dup' }] })),
    })).rejects.toThrow(/duplicate/i)

    await expect(readEmailObservation({
      url: 'https://mail.example.com/messages',
      protocol: 'rest-json',
      unreadOnly: false,
      maxMessages: 1,
      maxBodyBytes: 65_536,
      timeoutMs: 2_000,
      allowedOrigins,
      lookup,
      fetcher: async () => new Response(JSON.stringify({ messages: [{ id: '1' }, { id: '2' }] })),
    })).rejects.toThrow(/maxMessages/i)
  })

  test('normalizes Unicode subjects to NFC when matching subjectContains', async () => {
    const nfdMatch = await readEmailObservation({
      url: 'https://mail.example.com/messages',
      protocol: 'rest-json',
      subjectContains: 'caf\u00e9',
      unreadOnly: true,
      maxMessages: 10,
      maxBodyBytes: 65_536,
      timeoutMs: 2_000,
      allowedOrigins,
      lookup,
      fetcher: async () => new Response(JSON.stringify({
        messages: [{ id: 'nfd-1', unread: true, subject: 'cafe\u0301 receipt' }],
      })),
    })
    expect(nfdMatch.truthy).toBe(true)

    const nfcMatch = await readEmailObservation({
      url: 'https://mail.example.com/messages',
      protocol: 'rest-json',
      subjectContains: 'cafe\u0301',
      unreadOnly: true,
      maxMessages: 10,
      maxBodyBytes: 65_536,
      timeoutMs: 2_000,
      allowedOrigins,
      lookup,
      fetcher: async () => new Response(JSON.stringify({
        messages: [{ id: 'nfc-1', unread: true, subject: 'CAF\u00c9 Receipt' }],
      })),
    })
    expect(nfcMatch.truthy).toBe(true)
  })
})
