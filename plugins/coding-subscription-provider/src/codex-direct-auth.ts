import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { CodexDirectRequestRouting } from './codex-direct-responses.js'

export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
export const CODEX_OAUTH_REFRESH_URL = 'https://auth.openai.com/oauth/token'
/**
 * Private Responses routing is version-gated independently of this plugin's
 * package version. These compatibility identifiers describe this reconstructed
 * dialect; the deliberately minimal user agent is not byte-identical to the
 * platform/terminal-qualified value emitted by the official Codex binary.
 */
export const CODEX_WIRE_ORIGINATOR = 'codex_cli_rs'
export const CODEX_WIRE_CLIENT_VERSION = '0.149.1'
export const CODEX_WIRE_USER_AGENT = `${CODEX_WIRE_ORIGINATOR}/${CODEX_WIRE_CLIENT_VERSION}`

const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const MAX_AUTH_FILE_BYTES = 1024 * 1024
const MAX_REFRESH_RESPONSE_BYTES = 64 * 1024
const MAX_TOKEN_BYTES = 64 * 1024
const MAX_ACCOUNT_ID_BYTES = 4 * 1024
const BEARER_PREFIX = 'Bearer '
const MAX_ACCESS_TOKEN_BYTES = MAX_TOKEN_BYTES - Buffer.byteLength(BEARER_PREFIX, 'utf8')
const MAX_ROUTING_ID_BYTES = 64
const MAX_AUTH_READ_ATTEMPTS = 3
const MAX_PERSIST_ATTEMPTS = 3

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface CodexCredentialStoreOptions {
  readonly authFile?: string
  readonly fetch?: Fetch
  readonly refreshTimeoutMs?: number
  readonly now?: () => Date
}

interface CredentialTokens extends Record<string, unknown> {
  access_token: string
  refresh_token: string
  id_token: string
  account_id: string
}

interface CredentialDocument extends Record<string, unknown> {
  auth_mode: 'chatgpt'
  tokens: CredentialTokens
}

interface FileFingerprint {
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
}

interface CredentialSnapshot {
  readonly document: CredentialDocument
  readonly fingerprint: FileFingerprint
  readonly accessToken: string
  readonly refreshToken: string
  readonly idToken: string
  readonly accountId: string
}

interface RefreshTokens {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly idToken?: string
}

export type CodexDirectAuthFailure =
  | 'subscription-auth'
  | 'timeout'
  | 'provider-http'
  | 'protocol'
  | 'transport'

export class CodexDirectAuthError extends Error {
  readonly status: number | undefined

  constructor(
    message: string,
    cause: CodexDirectAuthFailure = 'subscription-auth',
    status?: number,
  ) {
    super(message, { cause })
    this.name = 'CodexDirectAuthError'
    this.status = status
  }
}

class CredentialSnapshotChangedError extends Error {}

/** Process-wide without ever placing raw credential material in the map key. */
const refreshFlights = new Map<string, Promise<CredentialSnapshot>>()

/**
 * Narrow credential capability for Codex's fixed private Responses endpoint.
 * It intentionally does not expose bearer tokens or a generic authenticated fetch.
 */
export class CodexCredentialStore {
  readonly #authFile: string
  readonly #fetch: Fetch
  readonly #refreshTimeoutMs: number
  readonly #now: () => Date

  constructor(options: CodexCredentialStoreOptions = {}) {
    const configuredHome = process.env.CODEX_HOME?.trim()
    const authFile = options.authFile ?? join(configuredHome || join(homedir(), '.codex'), 'auth.json')
    this.#authFile = resolve(authFile)
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#refreshTimeoutMs = requireRefreshTimeout(options.refreshTimeoutMs ?? 10_000)
    this.#now = options.now ?? (() => new Date())
  }

  async requestResponses(
    body: string,
    signal: AbortSignal,
    routing?: CodexDirectRequestRouting,
  ): Promise<Response> {
    throwIfCallerAborted(signal)
    const requestRouting = resolveRequestRouting(routing)
    const original = await readCredentialFile(this.#authFile)
    const first = await this.#postResponses(body, original, requestRouting, signal)
    if (first.status !== 401) return first
    discardBody(first)
    throwIfCallerAborted(signal)

    const onDisk = await readCredentialFile(this.#authFile)
    if (onDisk.accountId !== original.accountId) {
      throw new CodexDirectAuthError('Codex authentication account changed during unauthorized recovery')
    }
    const credentials = credentialsChanged(original, onDisk)
      ? onDisk
      : await waitForSignal(this.#refreshOnce(original), signal)
    assertSameAccount(original, credentials)
    return this.#postResponses(body, credentials, requestRouting, signal)
  }

  async #postResponses(
    body: string,
    credentials: CredentialSnapshot,
    routing: CodexDirectRequestRouting,
    signal: AbortSignal,
  ): Promise<Response> {
    throwIfCallerAborted(signal)
    const headers = createValidatedHeaders(() => ({
      ...attributionHeaders(),
      authorization: `${BEARER_PREFIX}${credentials.accessToken}`,
      'chatgpt-account-id': credentials.accountId,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'openai-beta': 'responses=v1',
      originator: CODEX_WIRE_ORIGINATOR,
      version: CODEX_WIRE_CLIENT_VERSION,
      'user-agent': CODEX_WIRE_USER_AGENT,
      'session-id': routing.sessionId,
      'thread-id': routing.threadId,
      // Match the current Codex client contract: request correlation follows
      // the thread identity, while cache affinity lives in prompt_cache_key.
      'x-client-request-id': routing.threadId,
    }))
    throwIfCallerAborted(signal)
    try {
      return await this.#fetch(CODEX_RESPONSES_URL, {
        method: 'POST',
        headers,
        body,
        signal,
        redirect: 'error',
        credentials: 'omit',
      })
    } catch {
      if (signal.aborted) throwCallerAbortReason(signal)
      throw new CodexDirectAuthError('Codex private Responses transport failed', 'transport')
    }
  }

  #refreshOnce(snapshot: CredentialSnapshot): Promise<CredentialSnapshot> {
    const key = refreshFlightKey(this.#authFile, snapshot)
    const current = refreshFlights.get(key)
    if (current !== undefined) return current

    const promise = this.#refresh(snapshot)
    refreshFlights.set(key, promise)
    void promise.finally(() => {
      if (refreshFlights.get(key) === promise) refreshFlights.delete(key)
    }).catch(() => {})
    return promise
  }

  async #refresh(snapshot: CredentialSnapshot): Promise<CredentialSnapshot> {
    const timeoutSignal = AbortSignal.timeout(this.#refreshTimeoutMs)
    const headers = createValidatedHeaders(() => ({
      ...attributionHeaders(),
      'content-type': 'application/json',
      accept: 'application/json',
    }))
    const body = JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: snapshot.refreshToken,
    })
    let response: Response
    try {
      response = await this.#fetch(CODEX_OAUTH_REFRESH_URL, {
        method: 'POST',
        headers,
        body,
        signal: timeoutSignal,
        redirect: 'error',
        credentials: 'omit',
      })
    } catch {
      if (timeoutSignal.aborted) {
        throw new CodexDirectAuthError('Codex OAuth token refresh timed out', 'timeout')
      }
      throw new CodexDirectAuthError('Codex OAuth token refresh transport failed', 'transport')
    }

    if (timeoutSignal.aborted) {
      discardBody(response)
      throw new CodexDirectAuthError('Codex OAuth token refresh timed out', 'timeout')
    }
    if (!response.ok) {
      discardBody(response)
      if (response.status === 400 || response.status === 401) {
        throw new CodexDirectAuthError(
          'Codex OAuth token refresh rejected the local ChatGPT session',
          'subscription-auth',
          response.status,
        )
      }
      throw new CodexDirectAuthError(
        `Codex OAuth token refresh returned HTTP ${response.status}`,
        'provider-http',
        response.status,
      )
    }

    let contents: string
    try {
      contents = await readBoundedBody(response, MAX_REFRESH_RESPONSE_BYTES, timeoutSignal)
    } catch (error: unknown) {
      if (timeoutSignal.aborted) {
        throw new CodexDirectAuthError('Codex OAuth token refresh timed out', 'timeout')
      }
      if (error instanceof CodexDirectAuthError) throw error
      throw new CodexDirectAuthError('Codex OAuth token refresh returned an invalid body', 'protocol')
    }
    if (timeoutSignal.aborted) {
      throw new CodexDirectAuthError('Codex OAuth token refresh timed out', 'timeout')
    }
    return this.#persistRefresh(snapshot, parseRefreshResponse(contents))
  }

  async #persistRefresh(snapshot: CredentialSnapshot, refreshed: RefreshTokens): Promise<CredentialSnapshot> {
    let refreshedAt: string
    try {
      refreshedAt = this.#now().toISOString()
    } catch {
      throw new CodexDirectAuthError('Could not securely update the Codex authentication file')
    }

    for (let attempt = 0; attempt < MAX_PERSIST_ATTEMPTS; attempt += 1) {
      const current = await readCredentialFile(this.#authFile)
      if (credentialsChanged(snapshot, current)) return assertSameAccount(snapshot, current)

      const tokens: CredentialTokens = {
        ...current.document.tokens,
        access_token: refreshed.accessToken,
        refresh_token: refreshed.refreshToken ?? current.refreshToken,
        id_token: refreshed.idToken ?? current.idToken,
        account_id: current.accountId,
      }
      const document: CredentialDocument = {
        ...current.document,
        auth_mode: 'chatgpt',
        tokens,
        last_refresh: refreshedAt,
      }
      const serialized = JSON.stringify(document)
      if (Buffer.byteLength(serialized, 'utf8') > MAX_AUTH_FILE_BYTES) {
        throw new CodexDirectAuthError('Refreshed Codex authentication data exceeds its safety limit')
      }

      const directory = dirname(this.#authFile)
      const temporary = join(directory, `.${basename(this.#authFile)}.dsh-${process.pid}-${randomUUID()}.tmp`)
      let temporaryExists = false
      try {
        await assertTrustedParent(this.#authFile)
        const handle = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        )
        temporaryExists = true
        let handleStat: BigIntStats
        try {
          await handle.chmod(0o600)
          await handle.writeFile(serialized, 'utf8')
          await handle.sync()
          handleStat = await handle.stat({ bigint: true })
          assertSecureTemporaryFile(handleStat, Buffer.byteLength(serialized, 'utf8'))
        } finally {
          await handle.close()
        }

        const temporaryStat = await lstat(temporary, { bigint: true })
        assertSecureTemporaryFile(temporaryStat, Buffer.byteLength(serialized, 'utf8'))
        if (temporaryStat.dev !== handleStat.dev || temporaryStat.ino !== handleStat.ino) {
          throw new CodexDirectAuthError('Codex authentication temporary file changed before persistence')
        }

        const beforeRename = await readCredentialFile(this.#authFile)
        if (credentialsChanged(snapshot, beforeRename)) return assertSameAccount(snapshot, beforeRename)
        if (!sameFingerprint(current.fingerprint, beforeRename.fingerprint)) continue

        await assertTrustedParent(this.#authFile)
        const finalTemporaryStat = await lstat(temporary, { bigint: true })
        assertSecureTemporaryFile(finalTemporaryStat, Buffer.byteLength(serialized, 'utf8'))
        if (finalTemporaryStat.dev !== handleStat.dev || finalTemporaryStat.ino !== handleStat.ino) {
          throw new CodexDirectAuthError('Codex authentication temporary file changed before rename')
        }

        /*
         * This compare-then-rename is deliberately best-effort across processes.
         * Official Codex writers do not share a lock with this plugin, so another
         * writer can still win after the final comparison.
         */
        await rename(temporary, this.#authFile)
        temporaryExists = false
        await syncDirectory(directory)
        return assertSameAccount(snapshot, await readCredentialFile(this.#authFile))
      } catch (error: unknown) {
        if (error instanceof CodexDirectAuthError) throw error
        throw new CodexDirectAuthError('Could not securely update the Codex authentication file')
      } finally {
        if (temporaryExists) await unlink(temporary).catch(() => {})
      }
    }

    throw new CodexDirectAuthError('Codex authentication file changed too often to update safely')
  }
}

async function readCredentialFile(path: string): Promise<CredentialSnapshot> {
  ensurePosixSecuritySupport()
  for (let attempt = 0; attempt < MAX_AUTH_READ_ATTEMPTS; attempt += 1) {
    try {
      return await readCredentialSnapshot(path)
    } catch (error: unknown) {
      if (error instanceof CredentialSnapshotChangedError) {
        if (attempt + 1 < MAX_AUTH_READ_ATTEMPTS) continue
        throw new CodexDirectAuthError('Codex authentication file changed while it was read')
      }
      if (error instanceof CodexDirectAuthError) throw error
      throw new CodexDirectAuthError('Could not securely read the Codex authentication file')
    }
  }
  throw new CodexDirectAuthError('Codex authentication file changed while it was read')
}

async function readCredentialSnapshot(path: string): Promise<CredentialSnapshot> {
  await assertTrustedParent(path)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const before = await lstat(path, { bigint: true })
    assertSecureAuthFile(before)
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat({ bigint: true })
    assertSecureAuthFile(opened)
    if (!sameFingerprint(fingerprint(before), fingerprint(opened))) {
      throw new CredentialSnapshotChangedError()
    }

    const bytes = await readBoundedFile(handle, MAX_AUTH_FILE_BYTES)
    const after = await handle.stat({ bigint: true })
    const afterPath = await lstat(path, { bigint: true })
    assertSecureAuthFile(after)
    assertSecureAuthFile(afterPath)
    if (!sameFingerprint(fingerprint(opened), fingerprint(after))
      || !sameFingerprint(fingerprint(after), fingerprint(afterPath))
      || after.size !== BigInt(bytes.byteLength)) {
      throw new CredentialSnapshotChangedError()
    }
    await assertTrustedParent(path)

    const document = parseCredentialDocument(decodeStrictUtf8(bytes))
    return {
      document,
      fingerprint: fingerprint(after),
      accessToken: document.tokens.access_token,
      refreshToken: document.tokens.refresh_token,
      idToken: document.tokens.id_token,
      accountId: document.tokens.account_id,
    }
  } catch (error: unknown) {
    if (error instanceof CredentialSnapshotChangedError || error instanceof CodexDirectAuthError) throw error
    throw new CodexDirectAuthError('Could not securely read the Codex authentication file')
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function assertTrustedParent(path: string): Promise<void> {
  ensurePosixSecuritySupport()
  const parent = dirname(path)
  try {
    const before = await lstat(parent, { bigint: true })
    assertSecureParent(before)
    const canonical = await realpath(parent)
    const canonicalStat = await lstat(canonical, { bigint: true })
    assertSecureParent(canonicalStat)
    const after = await lstat(parent, { bigint: true })
    assertSecureParent(after)
    // An administrator-owned home-directory alias (for example /home/user ->
    // /data/home/user) is common on managed hosts.  The immediate auth parent
    // must still be a real, current-user-owned, non-writable directory; pinning
    // its canonical inode before and after inspection prevents the alias from
    // redirecting this operation to a different directory.
    if (before.dev !== canonicalStat.dev || before.ino !== canonicalStat.ino
      || before.dev !== after.dev || before.ino !== after.ino) {
      throw new CodexDirectAuthError('Codex authentication parent changed while it was inspected')
    }
  } catch (error: unknown) {
    if (error instanceof CodexDirectAuthError) throw error
    throw new CodexDirectAuthError('Could not securely inspect the Codex authentication parent')
  }
}

function assertSecureParent(stat: BigIntStats): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CodexDirectAuthError('Codex authentication parent must be a regular directory')
  }
  if (stat.uid !== currentUid()) {
    throw new CodexDirectAuthError('Codex authentication parent must be owned by the current user')
  }
  if ((stat.mode & 0o22n) !== 0n) {
    throw new CodexDirectAuthError('Codex authentication parent permissions are unsafe')
  }
}

function assertSecureAuthFile(stat: BigIntStats): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CodexDirectAuthError('Codex authentication path must be a regular file')
  }
  if (stat.uid !== currentUid()) {
    throw new CodexDirectAuthError('Codex authentication file must be owned by the current user')
  }
  if ((stat.mode & 0o77n) !== 0n || stat.nlink !== 1n) {
    throw new CodexDirectAuthError('Codex authentication file permissions are unsafe')
  }
  if (stat.size <= 0n || stat.size > BigInt(MAX_AUTH_FILE_BYTES)) {
    throw new CodexDirectAuthError('Codex authentication file size is invalid')
  }
}

function assertSecureTemporaryFile(stat: BigIntStats, expectedBytes: number): void {
  if (!stat.isFile() || stat.isSymbolicLink()
    || stat.uid !== currentUid()
    || (stat.mode & 0o777n) !== 0o600n
    || stat.nlink !== 1n
    || stat.size !== BigInt(expectedBytes)) {
    throw new CodexDirectAuthError('Codex authentication temporary file is unsafe')
  }
}

async function readBoundedFile(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<Uint8Array> {
  const output = Buffer.allocUnsafe(maxBytes + 1)
  let total = 0
  while (total < output.byteLength) {
    const part = await handle.read(output, total, output.byteLength - total, null)
    if (part.bytesRead === 0) break
    total += part.bytesRead
  }
  if (total > maxBytes) {
    throw new CodexDirectAuthError('Codex authentication file exceeded its safety limit')
  }
  return output.subarray(0, total)
}

function decodeStrictUtf8(contents: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(contents)
  } catch {
    throw new CodexDirectAuthError('Codex authentication file is not valid UTF-8')
  }
}

function parseCredentialDocument(contents: string): CredentialDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    throw new CodexDirectAuthError('Codex authentication file is not valid JSON')
  }
  if (!isRecord(parsed) || parsed.auth_mode !== 'chatgpt' || !isRecord(parsed.tokens)) {
    throw new CodexDirectAuthError('Codex authentication file does not contain a ChatGPT session')
  }
  const tokens = parsed.tokens
  requireHeaderValue(tokens.access_token, 'access token', MAX_ACCESS_TOKEN_BYTES, 'subscription-auth')
  requireBoundedString(tokens.refresh_token, 'refresh token', MAX_TOKEN_BYTES, 'subscription-auth')
  requireBoundedString(tokens.id_token, 'ID token', MAX_TOKEN_BYTES, 'subscription-auth')
  requireHeaderValue(tokens.account_id, 'account id', MAX_ACCOUNT_ID_BYTES, 'subscription-auth')
  return parsed as CredentialDocument
}

function parseRefreshResponse(contents: string): RefreshTokens {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    throw new CodexDirectAuthError('Codex OAuth token refresh returned invalid JSON', 'protocol')
  }
  if (!isRecord(parsed)) {
    throw new CodexDirectAuthError('Codex OAuth token refresh returned an invalid payload', 'protocol')
  }
  const accessToken = requireHeaderValue(
    parsed.access_token,
    'refreshed access token',
    MAX_ACCESS_TOKEN_BYTES,
    'protocol',
  )
  const refreshToken = optionalBoundedString(
    parsed.refresh_token,
    'refreshed refresh token',
    MAX_TOKEN_BYTES,
    'protocol',
  )
  const idToken = optionalBoundedString(parsed.id_token, 'refreshed ID token', MAX_TOKEN_BYTES, 'protocol')
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(idToken === undefined ? {} : { idToken }),
  }
}

function requireBoundedString(
  value: unknown,
  label: string,
  maxBytes: number,
  cause: CodexDirectAuthFailure,
): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new CodexDirectAuthError(`Codex ${label} is missing or invalid`, cause)
  }
  return value
}

function requireHeaderValue(
  value: unknown,
  label: string,
  maxBytes: number,
  cause: CodexDirectAuthFailure,
): string {
  const parsed = requireBoundedString(value, label, maxBytes, cause)
  for (let index = 0; index < parsed.length; index += 1) {
    const code = parsed.charCodeAt(index)
    if (code <= 0x20 || code >= 0x7f) {
      throw new CodexDirectAuthError(`Codex ${label} cannot be used as a safe HTTP header value`, cause)
    }
  }
  return parsed
}

function optionalBoundedString(
  value: unknown,
  label: string,
  maxBytes: number,
  cause: CodexDirectAuthFailure,
): string | undefined {
  return value === undefined ? undefined : requireBoundedString(value, label, maxBytes, cause)
}

function validatedHeaders(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  for (const value of Object.values(headers)) {
    if (value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_TOKEN_BYTES) {
      throw new CodexDirectAuthError('Codex request header is invalid', 'protocol')
    }
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index)
      if ((code < 0x20 && code !== 0x09) || code >= 0x7f) {
        throw new CodexDirectAuthError('Codex request header is unsafe', 'protocol')
      }
    }
  }
  return headers
}

function createValidatedHeaders(
  factory: () => Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  try {
    return validatedHeaders(factory())
  } catch (error: unknown) {
    if (error instanceof CodexDirectAuthError) throw error
    throw new CodexDirectAuthError('Could not construct safe Codex request headers', 'protocol')
  }
}

function resolveRequestRouting(
  routing: CodexDirectRequestRouting | undefined,
): CodexDirectRequestRouting {
  if (routing === undefined) {
    const sessionId = randomUUID()
    const threadId = randomUUID()
    return Object.freeze({ sessionId, threadId, promptCacheKey: threadId })
  }
  return Object.freeze({
    sessionId: requireHeaderValue(
      routing.sessionId,
      'request session identifier',
      MAX_ROUTING_ID_BYTES,
      'protocol',
    ),
    threadId: requireHeaderValue(
      routing.threadId,
      'request thread identifier',
      MAX_ROUTING_ID_BYTES,
      'protocol',
    ),
    promptCacheKey: requireHeaderValue(
      routing.promptCacheKey,
      'prompt cache identifier',
      MAX_ROUTING_ID_BYTES,
      'protocol',
    ),
  })
}

function credentialsChanged(left: CredentialSnapshot, right: CredentialSnapshot): boolean {
  return left.accessToken !== right.accessToken
    || left.refreshToken !== right.refreshToken
    || left.idToken !== right.idToken
    || left.accountId !== right.accountId
}

function assertSameAccount(
  expected: CredentialSnapshot,
  candidate: CredentialSnapshot,
): CredentialSnapshot {
  if (candidate.accountId !== expected.accountId) {
    throw new CodexDirectAuthError('Codex authentication account changed during unauthorized recovery')
  }
  return candidate
}

function refreshFlightKey(path: string, snapshot: CredentialSnapshot): string {
  const hash = createHash('sha256')
  for (const value of [path, snapshot.accessToken, snapshot.refreshToken, snapshot.idToken, snapshot.accountId]) {
    hash.update(String(Buffer.byteLength(value, 'utf8')))
    hash.update(':')
    hash.update(value)
  }
  return hash.digest('hex')
}

function fingerprint(stat: BigIntStats): FileFingerprint {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  }
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let total = 0
  let output = ''
  try {
    while (true) {
      const part = await waitForSignal(reader.read(), signal)
      if (part.done) break
      total += part.value.byteLength
      if (total > maxBytes) {
        throw new CodexDirectAuthError('Codex OAuth token refresh response exceeded its safety limit', 'protocol')
      }
      output += decoder.decode(part.value, { stream: true })
    }
    return output + decoder.decode()
  } catch (error: unknown) {
    void reader.cancel().catch(() => {})
    if (signal.aborted) {
      throw new CodexDirectAuthError('Codex OAuth token refresh timed out', 'timeout')
    }
    if (error instanceof CodexDirectAuthError) throw error
    throw new CodexDirectAuthError('Could not read the Codex OAuth token refresh response', 'protocol')
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }
}

function discardBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {})
  } catch {}
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const aborted = () => rejectPromise(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    void promise.then(resolvePromise, rejectPromise).finally(() => signal.removeEventListener('abort', aborted))
  })
}

function requireRefreshTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new CodexDirectAuthError('Codex OAuth refresh timeout is invalid')
  }
  return value
}

function ensurePosixSecuritySupport(): void {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    throw new CodexDirectAuthError('Codex direct authentication requires POSIX file permissions')
  }
}

function currentUid(): bigint {
  ensurePosixSecuritySupport()
  return BigInt(process.getuid!())
}

function throwIfCallerAborted(signal: AbortSignal): void {
  if (signal.aborted) throwCallerAbortReason(signal)
}

function throwCallerAbortReason(signal: AbortSignal): never {
  throw signal.reason ?? new Error('Codex direct request aborted', { cause: 'abort' })
}
