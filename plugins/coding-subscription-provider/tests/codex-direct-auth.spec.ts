import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CODEX_OAUTH_REFRESH_URL,
  CODEX_RESPONSES_URL,
  CodexDirectAuthError,
  CodexCredentialStore,
} from '../src/codex-direct-auth.ts'

const roots: string[] = []

function credentialDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: 'access-old',
      refresh_token: 'refresh-old',
      id_token: 'id-old',
      account_id: 'account-1',
    },
    last_refresh: '2026-08-25T00:00:00.000Z',
    preserved: { future: true },
    ...overrides,
  }
}

async function temporaryRoot(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'dsh-codex-direct-auth-'))
  const root = await realpath(created)
  roots.push(root)
  return root
}

async function authFixture(overrides: Record<string, unknown> = {}): Promise<string> {
  const root = await temporaryRoot()
  const path = join(root, 'auth.json')
  await writeFile(path, JSON.stringify(credentialDocument(overrides)), { mode: 0o600 })
  return path
}

function reachableErrorText(value: unknown, seen = new Set<unknown>()): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[cycle]'
  seen.add(value)
  const record = value as Record<string, unknown>
  return Object.getOwnPropertyNames(value)
    .map(key => `${key}:${reachableErrorText(record[key], seen)}`)
    .join('|')
}

async function captureFailure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation
  } catch (error: unknown) {
    return error
  }
  throw new Error('expected operation to fail')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Codex direct credential store', () => {
  it('reads a private ChatGPT auth file and can send credentials only to the fixed Responses endpoint', async () => {
    const authFile = await authFixture()
    const fetcher = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response('ok'))
    const store = new CodexCredentialStore({ authFile, fetch: fetcher, refreshTimeoutMs: 1_000 })

    const response = await store.requestResponses('{"model":"gpt-test"}', new AbortController().signal)

    expect(await response.text()).toBe('ok')
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]!
    expect(String(url)).toBe(CODEX_RESPONSES_URL)
    expect(init).toMatchObject({ method: 'POST', body: '{"model":"gpt-test"}', redirect: 'error' })
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access-old')
    expect(new Headers(init?.headers).get('chatgpt-account-id')).toBe('account-1')
    expect(new Headers(init?.headers).get('accept')).toBe('text/event-stream')
    expect(new Headers(init?.headers).get('openai-beta')).toBe('responses=v1')
    expect(new Headers(init?.headers).get('originator')).toBe('dsh-enhanced')
    expect(new Headers(init?.headers).get('user-agent')).toBe(attributionHeaders()['user-agent'])
    expect(new Headers(init?.headers).get('session_id')).toMatch(/^[0-9a-f-]{36}$/u)
  })

  it('fixes a relative auth path to an absolute path when the store is constructed', async () => {
    const authFile = await authFixture()
    const elsewhere = await temporaryRoot()
    const fetcher = vi.fn(async () => new Response('ok'))
    const originalCwd = process.cwd()
    let store: CodexCredentialStore

    try {
      process.chdir(dirname(authFile))
      store = new CodexCredentialStore({ authFile: 'auth.json', fetch: fetcher, refreshTimeoutMs: 1_000 })
      process.chdir(elsewhere)
      await expect(store.requestResponses('{}', new AbortController().signal)).resolves.toMatchObject({ status: 200 })
    } finally {
      process.chdir(originalCwd)
    }

    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['group-readable file', async (path: string) => chmod(path, 0o640)],
    ['symlink', async (path: string) => {
      const link = `${path}.link`
      await symlink(path, link)
      return link
    }],
    ['non-ChatGPT auth', async (path: string) => writeFile(path, JSON.stringify({ auth_mode: 'apikey' }), { mode: 0o600 })],
  ] as const)('rejects an unsafe %s before any network request', async (_name, mutate) => {
    const original = await authFixture()
    const replacement = await mutate(original)
    const authFile = typeof replacement === 'string' ? replacement : original
    const fetcher = vi.fn(async () => new Response('never'))
    const store = new CodexCredentialStore({ authFile, fetch: fetcher, refreshTimeoutMs: 1_000 })

    await expect(store.requestResponses('{}', new AbortController().signal)).rejects.toMatchObject({
      cause: 'subscription-auth',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects a hardlinked auth file before any network request', async () => {
    const authFile = await authFixture()
    await link(authFile, `${authFile}.hardlink`)
    const fetcher = vi.fn(async () => new Response('never'))
    const store = new CodexCredentialStore({ authFile, fetch: fetcher })

    await expect(store.requestResponses('{}', new AbortController().signal)).rejects.toMatchObject({
      cause: 'subscription-auth',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects a group-writable auth parent before any network request', async () => {
    const authFile = await authFixture()
    await chmod(dirname(authFile), 0o770)
    const fetcher = vi.fn(async () => new Response('never'))
    const store = new CodexCredentialStore({ authFile, fetch: fetcher })

    await expect(store.requestResponses('{}', new AbortController().signal)).rejects.toMatchObject({
      cause: 'subscription-auth',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects an auth path whose parent is reached through a symlink', async () => {
    const root = await temporaryRoot()
    const actualParent = join(root, 'actual')
    const linkedParent = join(root, 'linked')
    await mkdir(actualParent, { mode: 0o700 })
    await writeFile(join(actualParent, 'auth.json'), JSON.stringify(credentialDocument()), { mode: 0o600 })
    await symlink(actualParent, linkedParent, 'dir')
    const fetcher = vi.fn(async () => new Response('never'))
    const store = new CodexCredentialStore({ authFile: join(linkedParent, 'auth.json'), fetch: fetcher })

    await expect(store.requestResponses('{}', new AbortController().signal)).rejects.toMatchObject({
      cause: 'subscription-auth',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('enforces the auth file byte limit while reading', async () => {
    const authFile = await authFixture()
    await writeFile(authFile, Buffer.alloc(1024 * 1024 + 1, 0x61), { mode: 0o600 })
    const fetcher = vi.fn(async () => new Response('never'))
    const store = new CodexCredentialStore({ authFile, fetch: fetcher })

    await expect(store.requestResponses('{}', new AbortController().signal)).rejects.toMatchObject({
      cause: 'subscription-auth',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects a snapshot that keeps changing while it is read', async () => {
    const authFile = await authFixture({ padding: 'x'.repeat(800_000) })
    const fetcher = vi.fn(async () => new Response('never'))
    const store = new CodexCredentialStore({ authFile, fetch: fetcher })
    let stopped = false
    let tick = 0
    const mutator = (async () => {
      while (!stopped) {
        const timestamp = new Date(1_700_000_000_000 + tick * 1_000)
        tick += 1
        await utimes(authFile, timestamp, timestamp)
      }
    })()

    const failure = await captureFailure(store.requestResponses('{}', new AbortController().signal))
      .finally(() => { stopped = true })
    await mutator

    expect(failure).toMatchObject({ cause: 'subscription-auth' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects credential fields that cannot safely become HTTP headers before fetch', async () => {
    const leaked = 'access-old\r\nx-leaked: secret'
    const authFile = await authFixture({
      tokens: {
        access_token: leaked,
        refresh_token: 'refresh-old',
        id_token: 'id-old',
        account_id: 'account-1',
      },
    })
    const fetcher = vi.fn(async () => new Response('never'))
    const store = new CodexCredentialStore({ authFile, fetch: fetcher, refreshTimeoutMs: 1_000 })

    let failure: unknown
    try {
      await store.requestResponses('{}', new AbortController().signal)
    } catch (error: unknown) {
      failure = error
    }
    expect(failure).toMatchObject({ cause: 'subscription-auth' })
    expect(String(failure)).not.toContain(leaked)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('classifies an access token whose Bearer header would exceed the limit as local subscription auth', async () => {
    const authFile = await authFixture({
      tokens: {
        access_token: 'a'.repeat(64 * 1024),
        refresh_token: 'refresh-old',
        id_token: 'id-old',
        account_id: 'account-1',
      },
    })
    const fetcher = vi.fn(async () => new Response('never'))
    const store = new CodexCredentialStore({ authFile, fetch: fetcher })

    await expect(store.requestResponses('{}', new AbortController().signal)).rejects.toMatchObject({
      cause: 'subscription-auth',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('refreshes once after 401, atomically preserves unknown fields, and retries with the new token', async () => {
    const authFile = await authFixture()
    const calls: Array<{ url: string; headers: Headers; body?: RequestInit['body'] }> = []
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers), body: init?.body })
      if (String(input) === CODEX_OAUTH_REFRESH_URL) {
        return new Response(JSON.stringify({
          access_token: 'access-new',
          refresh_token: 'refresh-new',
          id_token: 'id-new',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('', { status: calls.filter(call => call.url === CODEX_RESPONSES_URL).length === 1 ? 401 : 200 })
    })
    const store = new CodexCredentialStore({
      authFile,
      fetch: fetcher,
      refreshTimeoutMs: 1_000,
      now: () => new Date('2026-08-25T12:34:56.000Z'),
    })

    await expect(store.requestResponses('{}', new AbortController().signal)).resolves.toMatchObject({ status: 200 })

    expect(calls.map(call => call.url)).toEqual([
      CODEX_RESPONSES_URL,
      CODEX_OAUTH_REFRESH_URL,
      CODEX_RESPONSES_URL,
    ])
    expect(JSON.parse(String(calls[1]?.body))).toEqual({
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      grant_type: 'refresh_token',
      refresh_token: 'refresh-old',
    })
    expect(calls[1]?.headers.get('user-agent')).toBe(attributionHeaders()['user-agent'])
    expect(calls[2]?.headers.get('authorization')).toBe('Bearer access-new')
    const saved = JSON.parse(await readFile(authFile, 'utf8')) as Record<string, unknown>
    expect(saved).toMatchObject({
      preserved: { future: true },
      last_refresh: '2026-08-25T12:34:56.000Z',
      tokens: {
        access_token: 'access-new',
        refresh_token: 'refresh-new',
        id_token: 'id-new',
        account_id: 'account-1',
      },
    })
    expect((await lstat(authFile)).mode & 0o777).toBe(0o600)
  })

  it('does not refresh or replay a rejected request for any status other than 401', async () => {
    const authFile = await authFixture()
    const fetcher = vi.fn(async () => new Response('', { status: 403 }))
    const store = new CodexCredentialStore({ authFile, fetch: fetcher, refreshTimeoutMs: 1_000 })

    await expect(store.requestResponses('{}', new AbortController().signal)).resolves.toMatchObject({ status: 403 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('redacts the complete error chain when the Responses transport throws', async () => {
    const authFile = await authFixture()
    const original = new Error('outer access-old', {
      cause: new Error('inner refresh-old id-old account-1'),
    })
    const fetcher = vi.fn(async () => { throw original })
    const store = new CodexCredentialStore({ authFile, fetch: fetcher })

    const failure = await captureFailure(store.requestResponses('{}', new AbortController().signal))

    expect(failure).toBeInstanceOf(CodexDirectAuthError)
    expect(failure).toMatchObject({ cause: 'transport' })
    expect(failure).not.toBe(original)
    expect(reachableErrorText(failure)).not.toMatch(/access-old|refresh-old|id-old|account-1/u)
  })

  it('preserves the caller abort reason when the Responses transport observes its aborted signal', async () => {
    const authFile = await authFixture()
    const controller = new AbortController()
    const reason = new Error('caller stopped', { cause: 'abort' })
    const fetcher = vi.fn(async () => {
      controller.abort(reason)
      throw new Error('transport wrapper must not replace the caller reason')
    })
    const store = new CodexCredentialStore({ authFile, fetch: fetcher })

    await expect(store.requestResponses('{}', controller.signal)).rejects.toBe(reason)
  })

  it('does not let a pending initial 401 body cancellation suppress the caller abort reason', async () => {
    const authFile = await authFixture()
    const controller = new AbortController()
    const reason = new Error('caller stopped during 401 cleanup', { cause: 'abort' })
    let releaseCancellation: (() => void) | undefined
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        controller.abort(reason)
        return new Promise<void>(resolve => { releaseCancellation = resolve })
      },
    })
    const fetcher = vi.fn(async () => new Response(body, { status: 401 }))
    const store = new CodexCredentialStore({ authFile, fetch: fetcher, refreshTimeoutMs: 1_000 })
    const captured = captureFailure(store.requestResponses('{}', controller.signal))

    const timely = await Promise.race([
      captured,
      new Promise<'still-pending'>(resolve => setTimeout(() => resolve('still-pending'), 50)),
    ])
    releaseCancellation?.()
    await captured

    expect(timely).toBe(reason)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('shares one OAuth refresh across two store instances with the same path and full credential identity', async () => {
    const authFile = await authFixture()
    let releaseRefresh: (() => void) | undefined
    const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve })
    let responseAttempts = 0
    let refreshAttempts = 0
    const fetcher = vi.fn(async (input: string | URL) => {
      if (String(input) === CODEX_OAUTH_REFRESH_URL) {
        refreshAttempts += 1
        await refreshGate
        return new Response(JSON.stringify({ access_token: 'access-new' }), { status: 200 })
      }
      responseAttempts += 1
      return new Response('', { status: responseAttempts <= 2 ? 401 : 200 })
    })
    const firstStore = new CodexCredentialStore({ authFile, fetch: fetcher, refreshTimeoutMs: 5_000 })
    const secondStore = new CodexCredentialStore({ authFile, fetch: fetcher, refreshTimeoutMs: 5_000 })
    const signal = new AbortController().signal
    const first = firstStore.requestResponses('{}', signal)
    const second = secondStore.requestResponses('{}', signal)
    let attemptsBeforeRelease = 0
    try {
      await vi.waitFor(() => expect(responseAttempts).toBe(2))
      await vi.waitFor(() => expect(refreshAttempts).toBeGreaterThan(0))
      await new Promise<void>(resolve => setTimeout(resolve, 20))
      attemptsBeforeRelease = refreshAttempts
    } finally {
      releaseRefresh?.()
    }

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 200 }),
      expect.objectContaining({ status: 200 }),
    ])
    expect(attemptsBeforeRelease).toBe(1)
    expect(refreshAttempts).toBe(1)
  })

  it('does not share refreshes across different absolute auth paths', async () => {
    const firstAuthFile = await authFixture()
    const secondAuthFile = await authFixture()
    let releaseRefresh: (() => void) | undefined
    const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve })
    let refreshAttempts = 0
    const fetcher = vi.fn(async (input: string | URL) => {
      if (String(input) === CODEX_OAUTH_REFRESH_URL) {
        refreshAttempts += 1
        await refreshGate
        return new Response(JSON.stringify({ access_token: 'access-new' }), { status: 200 })
      }
      return new Response('', { status: 401 })
    })
    const first = new CodexCredentialStore({ authFile: firstAuthFile, fetch: fetcher, refreshTimeoutMs: 5_000 })
      .requestResponses('{}', new AbortController().signal)
    const second = new CodexCredentialStore({ authFile: secondAuthFile, fetch: fetcher, refreshTimeoutMs: 5_000 })
      .requestResponses('{}', new AbortController().signal)

    let attemptsBeforeRelease = 0
    try {
      await vi.waitFor(() => expect(refreshAttempts).toBeGreaterThan(0))
      await new Promise<void>(resolve => setTimeout(resolve, 20))
      attemptsBeforeRelease = refreshAttempts
    } finally {
      releaseRefresh?.()
    }
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 401 }),
      expect.objectContaining({ status: 401 }),
    ])
    expect(attemptsBeforeRelease).toBe(2)
    expect(refreshAttempts).toBe(2)
  })

  it('does not share a refresh when any credential identity field changes', async () => {
    const authFile = await authFixture()
    let releaseRefresh: (() => void) | undefined
    const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve })
    let refreshAttempts = 0
    const fetcher = vi.fn(async (input: string | URL) => {
      if (String(input) === CODEX_OAUTH_REFRESH_URL) {
        refreshAttempts += 1
        await refreshGate
        return new Response(JSON.stringify({ access_token: `access-new-${refreshAttempts}` }), { status: 200 })
      }
      return new Response('', { status: 401 })
    })
    const firstStore = new CodexCredentialStore({ authFile, fetch: fetcher, refreshTimeoutMs: 5_000 })
    const first = firstStore.requestResponses('{}', new AbortController().signal)
    await vi.waitFor(() => expect(refreshAttempts).toBe(1))
    await writeFile(authFile, JSON.stringify(credentialDocument({
      tokens: {
        access_token: 'access-old',
        refresh_token: 'refresh-old',
        id_token: 'id-other',
        account_id: 'account-1',
      },
    })), { mode: 0o600 })
    const secondStore = new CodexCredentialStore({ authFile, fetch: fetcher, refreshTimeoutMs: 5_000 })
    const second = secondStore.requestResponses('{}', new AbortController().signal)

    let attemptsBeforeRelease = 0
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 20))
      attemptsBeforeRelease = refreshAttempts
    } finally {
      releaseRefresh?.()
    }
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 401 }),
      expect.objectContaining({ status: 401 }),
    ])
    expect(attemptsBeforeRelease).toBe(2)
    expect(refreshAttempts).toBe(2)
  })

  it('merges refreshed credentials into a metadata-only persistence race and retries the compare/write', async () => {
    const authFile = await authFixture({ padding: 'x'.repeat(900_000) })
    const parent = dirname(authFile)
    const racedDocument = credentialDocument({ externally_updated: true })
    const racedFile = join(parent, '.external-auth.json')
    await writeFile(racedFile, JSON.stringify(racedDocument), { mode: 0o600 })
    let requestSettled = false
    const mutation = (async () => {
      while (!requestSettled) {
        const filename = (await readdir(parent))
          .find(candidate => candidate.startsWith('.auth.json.dsh-') && candidate.endsWith('.tmp'))
        if (filename !== undefined) {
          await rename(racedFile, authFile)
          return
        }
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      throw new Error('did not observe the persistence temporary file')
    })()
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (String(input) === CODEX_OAUTH_REFRESH_URL) {
        return new Response(JSON.stringify({ access_token: 'access-new', refresh_token: 'refresh-new' }), { status: 200 })
      }
      return new Response('', {
        status: new Headers(init?.headers).get('authorization') === 'Bearer access-new' ? 200 : 401,
      })
    })
    const store = new CodexCredentialStore({ authFile, fetch: fetcher, refreshTimeoutMs: 5_000 })
    const request = store.requestResponses('{}', new AbortController().signal)
      .finally(() => { requestSettled = true })

    const [response] = await Promise.all([request, mutation])
    expect(response).toMatchObject({ status: 200 })
    const saved = JSON.parse(await readFile(authFile, 'utf8')) as Record<string, unknown>
    expect(saved).toMatchObject({
      externally_updated: true,
      preserved: { future: true },
      tokens: {
        access_token: 'access-new',
        refresh_token: 'refresh-new',
        id_token: 'id-old',
        account_id: 'account-1',
      },
    })
  }, 10_000)

  it('reuses the session id for its single retry and returns a second 401 without refreshing again', async () => {
    const authFile = await authFixture()
    const responseSessionIds: string[] = []
    let refreshAttempts = 0
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (String(input) === CODEX_OAUTH_REFRESH_URL) {
        refreshAttempts += 1
        return new Response(JSON.stringify({ access_token: 'access-new' }), { status: 200 })
      }
      responseSessionIds.push(new Headers(init?.headers).get('session_id') ?? '')
      return new Response('', { status: 401 })
    })
    const store = new CodexCredentialStore({ authFile, fetch: fetcher, refreshTimeoutMs: 1_000 })

    await expect(store.requestResponses('{}', new AbortController().signal)).resolves.toMatchObject({ status: 401 })

    expect(refreshAttempts).toBe(1)
    expect(responseSessionIds).toHaveLength(2)
    expect(responseSessionIds[0]).toBe(responseSessionIds[1])
  })

  it.each([400, 401])('classifies OAuth HTTP %i as subscription authentication failure', async (status) => {
    const authFile = await authFixture()
    const fetcher = vi.fn(async (input: string | URL) => String(input) === CODEX_RESPONSES_URL
      ? new Response('', { status: 401 })
      : new Response('untrusted access-old refresh-old', { status }))
    const store = new CodexCredentialStore({ authFile, fetch: fetcher, refreshTimeoutMs: 1_000 })

    const failure = await captureFailure(store.requestResponses('{}', new AbortController().signal))

    expect(failure).toMatchObject({ cause: 'subscription-auth', status })
    expect(reachableErrorText(failure)).not.toMatch(/access-old|refresh-old/u)
  })

  it.each([429, 503])('classifies OAuth HTTP %i as a provider HTTP failure with status', async (status) => {
    const authFile = await authFixture()
    const fetcher = vi.fn(async (input: string | URL) => String(input) === CODEX_RESPONSES_URL
      ? new Response('', { status: 401 })
      : new Response('untrusted provider body', { status }))
    const store = new CodexCredentialStore({ authFile, fetch: fetcher, refreshTimeoutMs: 1_000 })

    await expect(store.requestResponses('{}', new AbortController().signal)).rejects.toMatchObject({
      cause: 'provider-http',
      status,
    })
  })

  it('does not let a pending OAuth error-body cancellation suppress HTTP classification', async () => {
    const authFile = await authFixture()
    let releaseCancellation: (() => void) | undefined
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        return new Promise<void>(resolve => { releaseCancellation = resolve })
      },
    })
    const fetcher = vi.fn(async (input: string | URL) => String(input) === CODEX_RESPONSES_URL
      ? new Response('', { status: 401 })
      : new Response(body, { status: 429 }))
    const store = new CodexCredentialStore({ authFile, fetch: fetcher, refreshTimeoutMs: 1_000 })
    const captured = captureFailure(store.requestResponses('{}', new AbortController().signal))

    const timely = await Promise.race([
      captured,
      new Promise<'still-pending'>(resolve => setTimeout(() => resolve('still-pending'), 50)),
    ])
    releaseCancellation?.()
    await captured

    expect(timely).not.toBe('still-pending')
    expect(timely).toMatchObject({ cause: 'provider-http', status: 429 })
  })

  it('classifies a refresh timeout without retaining the fetch exception', async () => {
    const authFile = await authFixture()
    const original = new Error('refresh-old timeout transport secret')
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (String(input) === CODEX_RESPONSES_URL) return new Response('', { status: 401 })
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        const aborted = () => reject(original)
        if (signal?.aborted === true) aborted()
        else signal?.addEventListener('abort', aborted, { once: true })
      })
    })
    const store = new CodexCredentialStore({ authFile, fetch: fetcher, refreshTimeoutMs: 5 })

    const failure = await captureFailure(store.requestResponses('{}', new AbortController().signal))

    expect(failure).toMatchObject({ cause: 'timeout' })
    expect(failure).not.toBe(original)
    expect(reachableErrorText(failure)).not.toContain('refresh-old')
  })

  it('applies the refresh timeout while a successful response body is still pending', async () => {
    const authFile = await authFixture()
    let releaseBody: (() => void) | undefined
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        return new Promise<void>(resolve => {
          releaseBody = () => {
            try {
              controller.close()
            } catch {}
            resolve()
          }
        })
      },
      cancel() {
        releaseBody?.()
      },
    })
    const fetcher = vi.fn(async (input: string | URL) => String(input) === CODEX_RESPONSES_URL
      ? new Response('', { status: 401 })
      : new Response(body, { status: 200 }))
    const store = new CodexCredentialStore({ authFile, fetch: fetcher, refreshTimeoutMs: 5 })
    const captured = captureFailure(store.requestResponses('{}', new AbortController().signal))

    const timely = await Promise.race([
      captured,
      new Promise<'still-pending'>(resolve => setTimeout(() => resolve('still-pending'), 50)),
    ])
    releaseBody?.()
    await captured

    expect(timely).not.toBe('still-pending')
    expect(timely).toMatchObject({ cause: 'timeout' })
  })

  it('does not let response cancellation suppress a refresh timeout that already fired', async () => {
    const authFile = await authFixture()
    let releaseCancellation: (() => void) | undefined
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        return new Promise<void>(resolve => { releaseCancellation = resolve })
      },
    })
    const fetcher = vi.fn(async (input: string | URL) => {
      if (String(input) === CODEX_RESPONSES_URL) return new Response('', { status: 401 })
      await new Promise<void>(resolve => setTimeout(resolve, 15))
      return new Response(body, { status: 200 })
    })
    const store = new CodexCredentialStore({ authFile, fetch: fetcher, refreshTimeoutMs: 5 })
    const captured = captureFailure(store.requestResponses('{}', new AbortController().signal))

    const timely = await Promise.race([
      captured,
      new Promise<'still-pending'>(resolve => setTimeout(() => resolve('still-pending'), 75)),
    ])
    releaseCancellation?.()
    await captured

    expect(timely).not.toBe('still-pending')
    expect(timely).toMatchObject({ cause: 'timeout' })
  })

  it('classifies an ordinary refresh network failure as redacted transport failure', async () => {
    const authFile = await authFixture()
    const original = new Error('access-old', { cause: new Error('refresh-old id-old account-1') })
    const fetcher = vi.fn(async (input: string | URL) => {
      if (String(input) === CODEX_RESPONSES_URL) return new Response('', { status: 401 })
      throw original
    })
    const store = new CodexCredentialStore({ authFile, fetch: fetcher, refreshTimeoutMs: 1_000 })

    const failure = await captureFailure(store.requestResponses('{}', new AbortController().signal))

    expect(failure).toMatchObject({ cause: 'transport' })
    expect(failure).not.toBe(original)
    expect(reachableErrorText(failure)).not.toMatch(/access-old|refresh-old|id-old|account-1/u)
  })

  it.each([
    ['invalid JSON', '{'],
    ['missing access token', JSON.stringify({ refresh_token: 'refresh-new' })],
  ])('classifies a successful malformed refresh payload (%s) as protocol failure', async (_name, body) => {
    const authFile = await authFixture()
    const fetcher = vi.fn(async (input: string | URL) => String(input) === CODEX_RESPONSES_URL
      ? new Response('', { status: 401 })
      : new Response(body, { status: 200 }))
    const store = new CodexCredentialStore({ authFile, fetch: fetcher, refreshTimeoutMs: 1_000 })

    await expect(store.requestResponses('{}', new AbortController().signal)).rejects.toMatchObject({
      cause: 'protocol',
    })
  })

  it('classifies an oversized successful refresh response as protocol failure', async () => {
    const authFile = await authFixture()
    const fetcher = vi.fn(async (input: string | URL) => String(input) === CODEX_RESPONSES_URL
      ? new Response('', { status: 401 })
      : new Response(JSON.stringify({ access_token: 'a'.repeat(64 * 1024) }), { status: 200 }))
    const store = new CodexCredentialStore({ authFile, fetch: fetcher, refreshTimeoutMs: 1_000 })

    await expect(store.requestResponses('{}', new AbortController().signal)).rejects.toMatchObject({
      cause: 'protocol',
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('never includes credential material in refresh failures', async () => {
    const authFile = await authFixture()
    const fetcher = vi.fn(async (input: string | URL) => String(input) === CODEX_RESPONSES_URL
      ? new Response('', { status: 401 })
      : new Response('{"error":"invalid_grant"}', { status: 400 }))
    const store = new CodexCredentialStore({ authFile, fetch: fetcher, refreshTimeoutMs: 1_000 })

    let failure: unknown
    try {
      await store.requestResponses('{}', new AbortController().signal)
    } catch (error: unknown) {
      failure = error
    }
    expect(failure).toMatchObject({ cause: 'subscription-auth' })
    expect(String(failure)).not.toContain('access-old')
    expect(String(failure)).not.toContain('refresh-old')
    expect(String(failure)).not.toContain('id-old')
  })
})
