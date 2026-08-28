import { realpathSync } from 'node:fs'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMessage, deepFreeze, markAgentLoopRequest, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveTrustedSessionCwd } from '../src/session-cwd.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function request(sessionId?: string): GenerateOptions {
  return {
    provider: 'codex-subscription',
    model: 'default',
    messages: [createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })],
    ...(sessionId === undefined ? {} : { sessionId: sessionId as NonNullable<GenerateOptions['sessionId']> }),
  }
}

function loopRequest(sessionId: string): GenerateOptions {
  return markAgentLoopRequest(deepFreeze(request(sessionId)))
}

function sessions(values: Record<string, { id: string; cwd?: string }>) {
  return {
    get(id: NonNullable<GenerateOptions['sessionId']>) {
      const value = values[String(id)]
      if (value === undefined) return undefined
      return {
        id: value.id as NonNullable<GenerateOptions['sessionId']>,
        header: value.cwd === undefined ? {} : { cwd: value.cwd },
      }
    },
  }
}

describe('coding subscription live session cwd binding', () => {
  it('accepts a loop-owned request when configured and live session cwd have the same canonical realpath', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-subscription-cwd-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const alias = join(root, 'workspace-alias')
    await mkdir(workspace)
    await symlink(workspace, alias)

    expect(resolveTrustedSessionCwd({
      request: loopRequest('session-live'),
      configuredCwd: alias,
      sessions: sessions({ 'session-live': { id: 'session-live', cwd: workspace } }),
    })).toBe(realpathSync.native(workspace))
  })

  it('rejects a request with no session identity before local process authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-subscription-cwd-'))
    roots.push(root)
    await expect(() => resolveTrustedSessionCwd({ request: request(), configuredCwd: root, sessions: sessions({}) }))
      .toThrow(/live loop session/i)
  })

  it('rejects an unmarked request even when it names a live matching session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-subscription-cwd-'))
    roots.push(root)
    await expect(() => resolveTrustedSessionCwd({
      request: deepFreeze(request('session-live')),
      configuredCwd: root,
      sessions: sessions({ 'session-live': { id: 'session-live', cwd: root } }),
    })).toThrow(/live loop session/i)
  })

  it('accepts a frozen adapter clone attested against the exact live Session object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-subscription-cwd-'))
    roots.push(root)
    const cloned = deepFreeze(request('session-live'))
    let claimedSession: object | undefined
    expect(resolveTrustedSessionCwd({
      request: cloned,
      configuredCwd: root,
      sessions: sessions({ 'session-live': { id: 'session-live', cwd: root } }),
      attestor: {
        claim(observed, session) {
          expect(observed).toBe(cloned)
          claimedSession = session
          return true
        },
      },
    })).toBe(realpathSync.native(root))
    expect(claimedSession).toMatchObject({ id: 'session-live' })
  })

  it('does not let attestation authorize an auxiliary model call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-subscription-cwd-'))
    roots.push(root)
    await expect(() => resolveTrustedSessionCwd({
      request: deepFreeze({ ...request('session-live'), purpose: 'session-title' }),
      configuredCwd: root,
      sessions: sessions({ 'session-live': { id: 'session-live', cwd: root } }),
      attestor: { claim: () => true },
    })).toThrow(/live loop session/i)
  })

  it('rejects an explicitly present undefined purpose even with a local loop marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-subscription-cwd-'))
    roots.push(root)
    const auxiliary = markAgentLoopRequest(deepFreeze({
      ...request('session-live'),
      purpose: undefined,
    } as unknown as GenerateOptions))
    await expect(() => resolveTrustedSessionCwd({
      request: auxiliary,
      configuredCwd: root,
      sessions: sessions({ 'session-live': { id: 'session-live', cwd: root } }),
    })).toThrow(/live loop session/i)
  })

  it('rejects a stale session identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-subscription-cwd-'))
    roots.push(root)
    await expect(() => resolveTrustedSessionCwd({
      request: loopRequest('session-stale'), configuredCwd: root, sessions: sessions({}),
    })).toThrow(/live loop session/i)
  })

  it('rejects a forged lookup result whose live id differs from the loop request id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-subscription-cwd-'))
    roots.push(root)
    await expect(() => resolveTrustedSessionCwd({
      request: loopRequest('session-claimed'), configuredCwd: root,
      sessions: sessions({ 'session-claimed': { id: 'session-other', cwd: root } }),
    })).toThrow(/live loop session/i)
  })

  it('rejects a canonical cwd mismatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-subscription-cwd-'))
    roots.push(root)
    const configured = join(root, 'configured')
    const other = join(root, 'other')
    await Promise.all([mkdir(configured), mkdir(other)])
    await expect(() => resolveTrustedSessionCwd({
      request: loopRequest('session-live'), configuredCwd: configured,
      sessions: sessions({ 'session-live': { id: 'session-live', cwd: other } }),
    })).toThrow(/cwd/i)
  })

  it('rejects a session cwd that escapes the configured root through a symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-subscription-cwd-'))
    roots.push(root)
    const configured = join(root, 'configured')
    const outside = join(root, 'outside')
    const escape = join(configured, 'escape')
    await Promise.all([mkdir(configured), mkdir(outside)])
    await symlink(outside, escape)
    await expect(() => resolveTrustedSessionCwd({
      request: loopRequest('session-live'), configuredCwd: configured,
      sessions: sessions({ 'session-live': { id: 'session-live', cwd: escape } }),
    })).toThrow(/cwd/i)
  })
})
