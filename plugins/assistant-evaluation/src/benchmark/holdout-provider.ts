import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

export const HOLDOUT_PROVIDER_TRANSPORT_V1 = 'dsh-benchmark/holdout-provider-transport/v1' as const
export type HoldoutProviderOperation = 'manifest' | 'input' | 'verdict' | 'finish'
export type HoldoutProviderErrorCode =
  | 'invalid-config' | 'aborted' | 'busy' | 'closed' | 'spawn-failed' | 'ready-timeout' | 'request-timeout'
  | 'protocol-error' | 'line-too-large' | 'stderr-too-large' | 'provider-rejected' | 'termination-unconfirmed'

export class HoldoutProviderError extends Error {
  constructor(readonly code: HoldoutProviderErrorCode) {
    super('assistant-evaluation: holdout provider ' + code)
    this.name = 'HoldoutProviderError'
  }
}

export interface HoldoutProviderConfig {
  readonly executable: string
  readonly args: readonly string[]
  /** Exact child environment. The Host environment is never inherited. */
  readonly environment: Readonly<Record<string, string>>
  readonly maxLineBytes: number
  readonly maxStderrBytes: number
  readonly readyTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly closeTimeoutMs: number
  readonly killTimeoutMs: number
}

export interface HoldoutProviderTransport {
  readonly pid: number
  request(operation: HoldoutProviderOperation, value: unknown, signal?: AbortSignal): Promise<unknown>
  close(): Promise<void>
}

type State = 'opening' | 'open' | 'failed' | 'closing' | 'closed'
type Pending = { id: string; resolve(value: unknown): void; reject(error: HoldoutProviderError): void; release(): void }
type Candidate = { pending: Pending; ok: true; value: unknown } | { pending: Pending; ok: false }
type ChildSettlement = { code: number | null; signal: NodeJS.Signals | null }

const operations = new Set<HoldoutProviderOperation>(['manifest', 'input', 'verdict', 'finish'])
const childErrorCode = /^[a-z][a-z0-9-]{0,63}$/u

function fail(code: HoldoutProviderErrorCode): never { throw new HoldoutProviderError(code) }
function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    && Object.getOwnPropertySymbols(value).length === 0
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(), expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}
function boundedText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && Buffer.byteLength(value, 'utf8') <= maximum && !value.includes('\0')
}
function normalize(raw: HoldoutProviderConfig): HoldoutProviderConfig {
  const keys = ['executable', 'args', 'environment', 'maxLineBytes', 'maxStderrBytes', 'readyTimeoutMs', 'requestTimeoutMs', 'closeTimeoutMs', 'killTimeoutMs']
  if (!plain(raw) || !exact(raw, keys) || !isAbsolute(raw.executable) || resolve(raw.executable) !== raw.executable || raw.executable.includes('\0')
    || !Array.isArray(raw.args) || raw.args.length > 64 || raw.args.some(value => !boundedText(value, 4_096, true))
    || Buffer.byteLength(JSON.stringify(raw.args), 'utf8') > 32 * 1024 || !plain(raw.environment) || Object.keys(raw.environment).length > 64
    || Object.entries(raw.environment).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key) || !boundedText(value, 8_192, true))
    || Buffer.byteLength(JSON.stringify(raw.environment), 'utf8') > 64 * 1024
    || !integer(raw.maxLineBytes, 256, 8 * 1024 * 1024) || !integer(raw.maxStderrBytes, 0, 1024 * 1024)
    || !integer(raw.readyTimeoutMs, 1, 300_000) || !integer(raw.requestTimeoutMs, 1, 300_000)
    || !integer(raw.closeTimeoutMs, 1, 60_000) || !integer(raw.killTimeoutMs, 1, 60_000)) fail('invalid-config')
  return Object.freeze({ ...raw, args: Object.freeze([...raw.args]), environment: Object.freeze({ ...raw.environment }) })
}
function encode(value: unknown, maximum: number): Buffer {
  let source: string | undefined
  try { source = JSON.stringify(value) } catch { return fail('protocol-error') }
  if (source === undefined) fail('protocol-error')
  const line = Buffer.from(source + '\n', 'utf8')
  if (line.byteLength > maximum + 1) fail('line-too-large')
  return line
}
function decode(line: Buffer): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)) as unknown } catch { return fail('protocol-error') }
  if (!plain(value)) fail('protocol-error')
  return value
}
class ChildProvider implements HoldoutProviderTransport {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #config: HoldoutProviderConfig
  readonly #grouped: boolean
  readonly #parentSignal: AbortSignal | undefined
  #state: State = 'opening'
  #pending: Pending | undefined
  #candidate: Candidate | undefined
  #candidateImmediate: ReturnType<typeof setImmediate> | undefined
  #pendingBytes = Buffer.alloc(0)
  #stderrBytes = 0
  #terminal?: ChildSettlement
  #resolveTerminal!: (value: ChildSettlement) => void
  readonly #childClosed: Promise<ChildSettlement>
  #resolveReady!: () => void
  #rejectReady!: (error: HoldoutProviderError) => void
  readonly #ready: Promise<void>
  #closePromise?: Promise<void>

  constructor(config: HoldoutProviderConfig, child: ChildProcessWithoutNullStreams, signal?: AbortSignal) {
    this.#config = config; this.#child = child; this.#grouped = process.platform !== 'win32'; this.#parentSignal = signal
    this.#childClosed = new Promise(resolveClose => { this.#resolveTerminal = resolveClose })
    this.#ready = new Promise((resolveReady, rejectReady) => { this.#resolveReady = resolveReady; this.#rejectReady = rejectReady })
    this.#attach()
  }
  get pid(): number { return this.#child.pid ?? fail('spawn-failed') }

  #attach(): void {
    this.#parentSignal?.addEventListener('abort', this.#onParentAbort, { once: true })
    this.#child.stdout.on('data', this.#onStdout)
    this.#child.stderr.on('data', this.#onStderr)
    this.#child.stdout.once('error', () => this.#poison('protocol-error'))
    this.#child.stderr.once('error', () => this.#poison('protocol-error'))
    this.#child.stdin.once('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') this.#poison('protocol-error') })
    this.#child.once('error', () => this.#poison('spawn-failed'))
    this.#child.once('close', (code, signal) => {
      this.#terminal = { code, signal }; this.#resolveTerminal(this.#terminal); this.#parentSignal?.removeEventListener('abort', this.#onParentAbort)
      if (this.#state === 'opening' || this.#state === 'open') this.#poison('closed')
      if (this.#state === 'closing') this.#state = 'closed'
    })
  }
  readonly #onParentAbort = (): void => { this.#poison('aborted') }
  readonly #onStderr = (chunk: Buffer): void => {
    this.#stderrBytes += chunk.byteLength
    if (this.#stderrBytes > this.#config.maxStderrBytes) this.#poison('stderr-too-large')
  }
  readonly #onStdout = (chunk: Buffer): void => {
    if (this.#state === 'failed' || this.#state === 'closing' || this.#state === 'closed') return
    if (this.#state === 'open' && (!this.#pending || this.#candidate) && chunk.byteLength > 0) return this.#poison('protocol-error')
    let start = 0
    const lines: Buffer[] = []
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 0x0a) continue
      const part = chunk.subarray(start, index)
      if (this.#pendingBytes.byteLength + part.byteLength > this.#config.maxLineBytes) return this.#poison('line-too-large')
      const line = this.#pendingBytes.byteLength === 0 ? part : Buffer.concat([this.#pendingBytes, part])
      this.#pendingBytes = Buffer.alloc(0); start = index + 1
      lines.push(line)
    }
    const tail = chunk.subarray(start)
    if (this.#pendingBytes.byteLength + tail.byteLength > this.#config.maxLineBytes) return this.#poison('line-too-large')
    if (tail.byteLength) this.#pendingBytes = this.#pendingBytes.byteLength === 0 ? Buffer.from(tail) : Buffer.concat([this.#pendingBytes, tail])
    if (lines.length > 1 || lines.length === 1 && tail.byteLength > 0) return this.#poison('protocol-error')
    if (lines[0]) { try { this.#accept(decode(lines[0])) } catch { this.#poison('protocol-error') } }
  }
  #accept(message: Record<string, unknown>): void {
    if (this.#state === 'opening') {
      if (!exact(message, ['protocol', 'type']) || message.protocol !== HOLDOUT_PROVIDER_TRANSPORT_V1 || message.type !== 'ready') fail('protocol-error')
      this.#state = 'open'; this.#resolveReady(); return
    }
    if (this.#state !== 'open' || !this.#pending || this.#candidate || message.protocol !== HOLDOUT_PROVIDER_TRANSPORT_V1 || message.type !== 'response' || message.id !== this.#pending.id || typeof message.ok !== 'boolean') fail('protocol-error')
    const pending = this.#pending
    if (message.ok === true) {
      if (!exact(message, ['protocol', 'type', 'id', 'ok', 'value'])) fail('protocol-error')
      this.#candidate = { pending, ok: true, value: message.value }
    } else {
      if (!exact(message, ['protocol', 'type', 'id', 'ok', 'error']) || !plain(message.error) || !exact(message.error, ['code']) || typeof message.error.code !== 'string' || !childErrorCode.test(message.error.code)) fail('protocol-error')
      this.#candidate = { pending, ok: false }
    }
    this.#candidateImmediate = setImmediate(() => {
      const candidate = this.#candidate
      this.#candidate = undefined; this.#candidateImmediate = undefined
      if (!candidate || this.#state !== 'open' || this.#pending !== candidate.pending) return
      if (!candidate.ok) { this.#poison('provider-rejected'); return }
      this.#pending = undefined; candidate.pending.release(); candidate.pending.resolve(candidate.value)
    })
  }
  #kill(signal: NodeJS.Signals): void {
    const pid = this.#child.pid
    if (pid === undefined) return
    if (this.#grouped && this.#groupExists()) {
      try { process.kill(-pid, signal); return } catch { /* Probe-to-signal races are treated as already gone. */ }
    }
    if (!this.#terminal) { try { this.#child.kill(signal) } catch { /* already exited */ } }
  }
  #groupExists(): boolean {
    const pid = this.#child.pid
    if (!this.#grouped || pid === undefined) return false
    try { process.kill(-pid, 0); return true } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }
  async #awaitChild(milliseconds: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([this.#childClosed.then(() => true), new Promise<false>(resolveWait => {
        timeout = setTimeout(() => resolveWait(false), milliseconds); timeout.unref()
      })])
    } finally { if (timeout !== undefined) clearTimeout(timeout) }
  }
  async #awaitTermination(milliseconds: number): Promise<boolean> {
    const deadline = Date.now() + milliseconds
    while (!this.#terminal || this.#groupExists()) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      await new Promise<void>(resolveWait => {
        setTimeout(resolveWait, Math.min(remaining, 10))
      })
    }
    return true
  }
  #poison(code: HoldoutProviderErrorCode): void {
    if (this.#state === 'failed' || this.#state === 'closed') return
    this.#state = 'failed'
    const error = new HoldoutProviderError(code)
    if (this.#candidateImmediate) clearImmediate(this.#candidateImmediate)
    this.#candidate = undefined; this.#candidateImmediate = undefined
    this.#rejectReady(error); this.#pending?.reject(error); this.#pending?.release(); this.#pending = undefined
    this.#child.stdin.destroy(); this.#kill('SIGTERM'); void this.close().catch(() => undefined)
  }
  async open(): Promise<void> {
    const timeout = setTimeout(() => this.#poison('ready-timeout'), this.#config.readyTimeoutMs); timeout.unref()
    try { await this.#ready } catch (error) { await this.close(); throw error } finally { clearTimeout(timeout) }
  }
  async request(operation: HoldoutProviderOperation, value: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.#state !== 'open') fail('closed')
    if (this.#pending) fail('busy')
    if (!operations.has(operation)) fail('protocol-error')
    if (this.#parentSignal?.aborted || signal?.aborted) { this.#poison('aborted'); fail('aborted') }
    const id = randomUUID()
    let reserved = true
    this.#pending = { id, resolve: () => undefined, reject: () => undefined, release: () => undefined }
    let body: Buffer
    try { body = encode({ protocol: HOLDOUT_PROVIDER_TRANSPORT_V1, type: 'request', id, operation, value }, this.#config.maxLineBytes) }
    catch (error) { this.#pending = undefined; reserved = false; this.#poison(error instanceof HoldoutProviderError ? error.code : 'protocol-error'); throw error }
    if (this.#parentSignal?.aborted || signal?.aborted || this.#state !== 'open') { this.#poison('aborted'); fail('aborted') }
    return await new Promise<unknown>((resolveRequest, rejectRequest) => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      const abort = (): void => this.#poison('aborted')
      const release = (): void => { if (timeout) clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
      if (!reserved || this.#pending?.id !== id) { rejectRequest(new HoldoutProviderError('closed')); return }
      this.#pending = { id, resolve: resolveRequest, reject: rejectRequest, release }; reserved = false
      signal?.addEventListener('abort', abort, { once: true })
      if (this.#parentSignal?.aborted || signal?.aborted || this.#state !== 'open') { this.#poison('aborted'); return }
      timeout = setTimeout(() => this.#poison('request-timeout'), this.#config.requestTimeoutMs); timeout.unref()
      this.#child.stdin.write(body, error => { if (error) this.#poison('protocol-error') })
    })
  }
  close(): Promise<void> {
    return this.#closePromise ??= this.#shutdown()
  }
  async #shutdown(): Promise<void> {
    if (this.#state !== 'failed' && this.#state !== 'closed') this.#state = 'closing'
    this.#parentSignal?.removeEventListener('abort', this.#onParentAbort)
    if (this.#candidateImmediate) clearImmediate(this.#candidateImmediate)
    this.#candidate = undefined; this.#candidateImmediate = undefined
    this.#pending?.reject(new HoldoutProviderError('closed')); this.#pending?.release(); this.#pending = undefined
    if (!this.#child.stdin.destroyed) { try { this.#child.stdin.write(encode({ protocol: HOLDOUT_PROVIDER_TRANSPORT_V1, type: 'close' }, this.#config.maxLineBytes)); this.#child.stdin.end() } catch { this.#child.stdin.destroy() } }
    await this.#awaitChild(this.#config.closeTimeoutMs)
    if (!this.#terminal || this.#groupExists()) this.#kill('SIGTERM')
    if (!await this.#awaitTermination(this.#config.killTimeoutMs)) this.#kill('SIGKILL')
    if (!await this.#awaitTermination(this.#config.killTimeoutMs)) { this.#child.stdout.destroy(); this.#child.stderr.destroy(); this.#child.stdin.destroy(); this.#state = 'closed'; fail('termination-unconfirmed') }
    this.#state = 'closed'
  }
}

export async function openHoldoutProvider(raw: HoldoutProviderConfig, signal?: AbortSignal): Promise<HoldoutProviderTransport> {
  const config = normalize(raw)
  if (signal?.aborted) fail('aborted')
  let child: ChildProcessWithoutNullStreams
  try { child = spawn(config.executable, [...config.args], { cwd: '/', env: { ...config.environment }, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }) } catch { return fail('spawn-failed') }
  const provider = new ChildProvider(config, child, signal)
  await provider.open()
  return Object.freeze(provider)
}
