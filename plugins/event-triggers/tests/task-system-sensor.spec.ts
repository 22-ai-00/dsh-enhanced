import { describe, expect, test, vi } from 'vitest'
import { readTaskSystemObservation } from '../src/task-system-sensor.ts'

const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
const allowedOrigins = new Set(['https://tasks.example.com'])

describe('task-system sensor', () => {
  test('extracts custom pointer/fields, filters by status/assignee/since, hashes title, and tracks cursors', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers)
      expect(headers.get('x-api-key')).toBe('task-secret-token')
      return new Response(JSON.stringify({
        nextSyncToken: 'sync-v1',
        data: {
          tasks: [
            { key: 'TSK-2', state: 'open', owner: 'alice', changedAt: '2026-02-01T10:00:00Z', summary: 'Secret task title two' },
            { key: 'TSK-1', state: 'closed', owner: 'alice', changedAt: '2026-02-01T12:00:00Z', summary: 'Closed task' },
            { key: 'TSK-3', state: 'open', owner: 'bob', changedAt: '2026-02-01T11:00:00Z', summary: 'Other assignee' },
            { key: 'TSK-4', state: 'open', owner: 'alice', changedAt: '2025-12-31T00:00:00Z', summary: 'Too old' },
          ],
        },
      }), { status: 200, headers: { etag: '"etag-tasks-1"' } })
    })

    const obs = await readTaskSystemObservation({
      url: 'https://tasks.example.com/api/tasks',
      itemsPointer: '/data/tasks',
      fields: { id: 'key', status: 'state', assignee: 'owner', updatedAt: 'changedAt', title: 'summary' },
      statusFilter: ['open'],
      assigneeFilter: ['alice'],
      since: '2026-01-01T00:00:00Z',
      maxItems: 50,
      token: 'task-secret-token',
      authScheme: 'x-api-key',
      maxBodyBytes: 65_536,
      timeoutMs: 2_000,
      allowedOrigins,
      lookup,
      fetcher,
    })

    expect(obs.truthy).toBe(true)
    expect(obs.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u)
    expect(JSON.stringify(obs)).not.toContain('Secret task title two')
    expect(JSON.stringify(obs)).not.toContain('task-secret-token')
    expect(obs.nextCursor).toEqual({
      etag: '"etag-tasks-1"',
      syncToken: 'sync-v1',
      since: '2026-02-01T10:00:00Z',
    })
  })

  test('handles HTTP 304 Not Modified via If-None-Match when baseline exists', async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain('syncToken=sync-v1')
      const headers = new Headers(init.headers)
      expect(headers.get('if-none-match')).toBe('"etag-tasks-1"')
      expect(headers.get('authorization')).toBe('Bearer tok-1')
      return new Response(null, { status: 304, headers: { etag: '"etag-tasks-1"' } })
    })

    const obs = await readTaskSystemObservation({
      url: 'https://tasks.example.com/api/tasks',
      itemsPointer: '',
      maxItems: 100,
      token: 'tok-1',
      authScheme: 'bearer',
      cursor: { etag: '"etag-tasks-1"', syncToken: 'sync-v1', since: '2026-02-01T10:00:00Z' },
      hasBaseline: true,
      maxBodyBytes: 65_536,
      timeoutMs: 2_000,
      allowedOrigins,
      lookup,
      fetcher,
    })

    expect(obs.notModified).toBe(true)
    expect(obs.nextCursor).toEqual({ etag: '"etag-tasks-1"', syncToken: 'sync-v1', since: '2026-02-01T10:00:00Z' })
  })

  test('fails closed on duplicate ids, exceeding maxItems, and paginated responses', async () => {
    await expect(readTaskSystemObservation({
      url: 'https://tasks.example.com/tasks',
      itemsPointer: '',
      maxItems: 10,
      maxBodyBytes: 65_536,
      timeoutMs: 2_000,
      allowedOrigins,
      lookup,
      fetcher: async () => new Response(JSON.stringify([{ id: '1' }, { id: '1' }])),
    })).rejects.toThrow(/duplicate/i)

    await expect(readTaskSystemObservation({
      url: 'https://tasks.example.com/tasks',
      itemsPointer: '',
      maxItems: 1,
      maxBodyBytes: 65_536,
      timeoutMs: 2_000,
      allowedOrigins,
      lookup,
      fetcher: async () => new Response(JSON.stringify([{ id: '1' }, { id: '2' }])),
    })).rejects.toThrow(/maxItems/i)

    await expect(readTaskSystemObservation({
      url: 'https://tasks.example.com/tasks',
      itemsPointer: '',
      maxItems: 10,
      maxBodyBytes: 65_536,
      timeoutMs: 2_000,
      allowedOrigins,
      lookup,
      fetcher: async () => new Response('[]', { headers: { link: '<https://tasks.example.com?page=2>; rel="next"' } }),
    })).rejects.toThrow(/paginated/i)
  })
})
