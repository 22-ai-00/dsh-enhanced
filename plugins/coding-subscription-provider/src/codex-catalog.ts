import { spawn as nodeSpawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { buildSubscriptionEnv } from './process.js'

export interface CodexCatalogInvocation {
  readonly command: string
  readonly cwd: string
}

export interface CodexCatalogReasoningEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface CodexCatalogModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning?: {
    readonly efforts: readonly CodexCatalogReasoningEffort[]
    readonly defaultEffort?: string
  }
  readonly inputModalities: readonly string[]
}

export interface CodexCatalog {
  readonly models: readonly CodexCatalogModel[]
  readonly defaultModel?: string
  readonly observedAt: number
}

export interface CodexCatalogProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'error' | 'close' | 'spawn', listener: (...args: any[]) => void): this
}

export type CodexCatalogSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string
    shell: false
    detached: boolean
    stdio: readonly ['pipe', 'pipe', 'pipe']
    env: NodeJS.ProcessEnv
  },
) => CodexCatalogProcess

export interface DiscoverCodexModelsOptions {
  readonly spawn?: CodexCatalogSpawn
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly killGraceMs?: number
  readonly maxLineBytes?: number
  readonly maxOutputBytes?: number
  readonly maxStderrBytes?: number
  readonly extraEnvNames?: readonly string[]
  readonly onDiagnostic?: (diagnostic: string) => void
}

const APP_SERVER_ARGS = ['app-server', '--config', 'model_provider="openai"'] as const
const MAX_CATALOG_PAGES = 20
const MAX_CATALOG_MODELS = 1_000
const defaults = {
  timeoutMs: 10_000,
  killGraceMs: 3_000,
  maxLineBytes: 256 * 1024,
  maxOutputBytes: 2 * 1024 * 1024,
  maxStderrBytes: 32 * 1024,
}

const defaultSpawn: CodexCatalogSpawn = (command, args, options) => nodeSpawn(
  command,
  [...args],
  { ...options, stdio: [...options.stdio] },
) as CodexCatalogProcess

interface CloseResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

interface RawCatalogPage {
  readonly models: CodexCatalogModel[]
  readonly defaultModels: string[]
  readonly nextCursor: string | null
}

/**
 * Discover Codex's picker-visible subscription models through the stable app-server `model/list`
 * method. The subprocess is forced to the built-in `openai` model provider, creates no thread or
 * turn, and closes immediately after all catalog pages have been validated.
 */
export async function discoverCodexModels(
  invocation: CodexCatalogInvocation,
  options: DiscoverCodexModelsOptions = {},
): Promise<CodexCatalog> {
  if (invocation.command.trim().length === 0 || !isAbsolute(invocation.cwd)) throw catalogError('protocol')
  if (options.signal?.aborted) throw abortError(options.signal)

  const timeoutMs = positiveInteger(options.timeoutMs, defaults.timeoutMs)
  const killGraceMs = positiveInteger(options.killGraceMs, defaults.killGraceMs)
  const maxLineBytes = positiveInteger(options.maxLineBytes, defaults.maxLineBytes)
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, defaults.maxOutputBytes)
  const maxStderrBytes = positiveInteger(options.maxStderrBytes, defaults.maxStderrBytes)
  const spawn = options.spawn ?? defaultSpawn
  const child = spawn(invocation.command, APP_SERVER_ARGS, {
    cwd: invocation.cwd,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildSubscriptionEnv(options.extraEnvNames),
  })

  let closed = false
  let closeResult: CloseResult | undefined
  const closePromise = new Promise<CloseResult>(resolve => {
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      closed = true
      closeResult = { code, signal }
      resolve(closeResult)
    })
  })
  const spawnError = new Promise<never>((_resolve, reject) => {
    child.once('error', reject)
  })

  let rejectResponse!: (error: unknown) => void
  let resolveResponse!: (catalog: CodexCatalog) => void
  const response = new Promise<CodexCatalog>((resolve, reject) => {
    resolveResponse = resolve
    rejectResponse = reject
  })
  let responseSettled = false
  let pending = Buffer.alloc(0)
  let protocolBytes = 0
  let stderr = ''
  let nextRequestId = 1
  let expectedResponseId = 0
  let pages = 0
  const cursors = new Set<string>()
  const models: CodexCatalogModel[] = []
  const defaultModels: string[] = []

  const fail = (error: unknown): void => {
    if (responseSettled) return
    responseSettled = true
    rejectResponse(error)
  }
  const send = (message: unknown): void => {
    if (responseSettled) return
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    } catch (error) {
      fail(error)
    }
  }
  const requestPage = (cursor?: string): void => {
    expectedResponseId = nextRequestId++
    send({
      method: 'model/list',
      id: expectedResponseId,
      params: { limit: 100, includeHidden: false, ...(cursor === undefined ? {} : { cursor }) },
    })
  }
  const acceptMessage = (message: unknown): void => {
    const envelope = jsonObject(message)
    if (envelope === undefined || Object.hasOwn(envelope, 'jsonrpc')) throw catalogError('protocol')
    if (typeof envelope.method === 'string') {
      // Notifications are informational during catalog discovery. A server-initiated request is
      // never needed because this client advertises no corresponding capability.
      if (Object.hasOwn(envelope, 'id')) throw catalogError('protocol')
      return
    }
    if (envelope.id !== expectedResponseId || Object.hasOwn(envelope, 'error') || !Object.hasOwn(envelope, 'result')) {
      throw catalogError('protocol')
    }
    if (expectedResponseId === 0) {
      validateInitializeResult(envelope.result)
      send({ method: 'initialized', params: {} })
      requestPage()
      return
    }

    const page = validateCatalogPage(envelope.result)
    pages += 1
    if (pages > MAX_CATALOG_PAGES || models.length + page.models.length > MAX_CATALOG_MODELS) {
      throw catalogError('protocol')
    }
    models.push(...page.models)
    defaultModels.push(...page.defaultModels)
    if (page.nextCursor !== null) {
      if (cursors.has(page.nextCursor)) throw catalogError('protocol')
      cursors.add(page.nextCursor)
      requestPage(page.nextCursor)
      return
    }
    if (models.length === 0 || new Set(models.map(model => model.id)).size !== models.length
      || defaultModels.length > 1) {
      throw catalogError('protocol')
    }
    responseSettled = true
    resolveResponse({
      models,
      ...(defaultModels[0] === undefined ? {} : { defaultModel: defaultModels[0] }),
      observedAt: Date.now(),
    })
  }
  const onStdout = (chunk: Buffer | string): void => {
    if (responseSettled) return
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      protocolBytes += bytes.length
      if (protocolBytes > maxOutputBytes) throw catalogError('protocol')
      pending = Buffer.concat([pending, bytes])
      while (true) {
        const newline = pending.indexOf(0x0a)
        if (newline < 0) break
        if (newline > maxLineBytes) throw catalogError('protocol')
        const line = pending.subarray(0, newline)
        pending = pending.subarray(newline + 1)
        const text = line.toString('utf8').trim()
        if (text.length === 0) throw catalogError('protocol')
        acceptMessage(JSON.parse(text))
      }
      if (pending.length > maxLineBytes) throw catalogError('protocol')
    } catch (error) {
      fail(error instanceof SyntaxError ? catalogError('protocol') : error)
    }
  }
  const onStdoutError = (error: unknown): void => fail(error)
  const onStderr = (chunk: Buffer | string): void => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
    stderr = `${stderr}${text}`
    while (Buffer.byteLength(stderr) > maxStderrBytes) stderr = stderr.slice(Math.ceil(stderr.length / 8))
  }
  child.stdout.on('data', onStdout)
  child.stdout.on('error', onStdoutError)
  child.stderr.on('data', onStderr)
  child.stderr.on('error', onStdoutError)

  let operationTimer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    operationTimer = setTimeout(() => reject(catalogError('timeout')), timeoutMs)
    operationTimer.unref?.()
  })
  let removeAbort = (): void => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    if (options.signal === undefined) return
    const onAbort = (): void => reject(abortError(options.signal!))
    options.signal.addEventListener('abort', onAbort, { once: true })
    removeAbort = () => options.signal?.removeEventListener('abort', onAbort)
  })
  const prematureClose = closePromise.then(result => {
    throw result.code === 0 && result.signal === null ? catalogError('protocol') : processExitError(result)
  })

  send({
    method: 'initialize',
    id: 0,
    params: {
      clientInfo: {
        name: 'dsh_enhanced',
        title: 'DSH Enhanced',
        version: '0.1.0',
      },
    },
  })

  try {
    const catalog = await Promise.race([response, spawnError, prematureClose, timeout, aborted])
    child.stdin.end()
    const result = closed ? closeResult! : await waitForClose(child, closePromise, killGraceMs)
    if (result.code !== 0 || result.signal !== null) throw processExitError(result)
    return catalog
  } catch (error) {
    try { child.stdin.end() } catch { /* best-effort close */ }
    if (!closed) {
      child.kill('SIGINT')
      if (!await closesWithin(closePromise, killGraceMs)) {
        child.kill('SIGKILL')
        await closesWithin(closePromise, killGraceMs)
      }
    }
    throw error
  } finally {
    clearTimeout(operationTimer)
    removeAbort()
    child.stdout.off('data', onStdout)
    child.stdout.off('error', onStdoutError)
    child.stderr.off('data', onStderr)
    child.stderr.off('error', onStdoutError)
    if (stderr.trim().length > 0) {
      try { options.onDiagnostic?.(stderr.trim()) } catch { /* diagnostics never affect discovery */ }
    }
  }
}

async function waitForClose(
  child: CodexCatalogProcess,
  closePromise: Promise<CloseResult>,
  graceMs: number,
): Promise<CloseResult> {
  const first = await closeWithin(closePromise, graceMs)
  if (first !== undefined) return first
  child.kill('SIGINT')
  const afterInterrupt = await closeWithin(closePromise, graceMs)
  if (afterInterrupt !== undefined) return afterInterrupt
  child.kill('SIGKILL')
  const afterKill = await closeWithin(closePromise, graceMs)
  if (afterKill !== undefined) return afterKill
  throw catalogError('process-exit')
}

async function closesWithin(closePromise: Promise<CloseResult>, graceMs: number): Promise<boolean> {
  return (await closeWithin(closePromise, graceMs)) !== undefined
}

function closeWithin(closePromise: Promise<CloseResult>, graceMs: number): Promise<CloseResult | undefined> {
  return new Promise(resolve => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(undefined)
    }, graceMs)
    timer.unref?.()
    void closePromise.then(result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    })
  })
}

function validateInitializeResult(value: unknown): void {
  const result = jsonObject(value)
  if (result === undefined || typeof result.userAgent !== 'string' || result.userAgent.length === 0
    || typeof result.platformFamily !== 'string' || typeof result.platformOs !== 'string') {
    throw catalogError('protocol')
  }
}

function validateCatalogPage(value: unknown): RawCatalogPage {
  const result = jsonObject(value)
  if (result === undefined || !Array.isArray(result.data)
    || (result.nextCursor !== null && typeof result.nextCursor !== 'string')) {
    throw catalogError('protocol')
  }
  const models: CodexCatalogModel[] = []
  const defaultModels: string[] = []
  for (const item of result.data) {
    const candidate = jsonObject(item)
    if (candidate === undefined || typeof candidate.id !== 'string' || candidate.id.length === 0
      || typeof candidate.model !== 'string' || candidate.model.length === 0
      || typeof candidate.displayName !== 'string' || candidate.displayName.length === 0
      || candidate.hidden !== false || typeof candidate.isDefault !== 'boolean'
      || !Array.isArray(candidate.supportedReasoningEfforts)
      || !Array.isArray(candidate.inputModalities)
      || candidate.inputModalities.some(modality => typeof modality !== 'string' || modality.length === 0)) {
      throw catalogError('protocol')
    }
    const efforts = candidate.supportedReasoningEfforts.map(rawEffort => {
      const effort = jsonObject(rawEffort)
      if (effort === undefined || typeof effort.reasoningEffort !== 'string' || effort.reasoningEffort.length === 0
        || (effort.description !== null && effort.description !== undefined && typeof effort.description !== 'string')) {
        throw catalogError('protocol')
      }
      return {
        id: effort.reasoningEffort,
        name: displayEffort(effort.reasoningEffort),
        ...(typeof effort.description === 'string' && effort.description.length > 0
          ? { description: effort.description }
          : {}),
      }
    })
    if (new Set(efforts.map(effort => effort.id)).size !== efforts.length
      || (candidate.defaultReasoningEffort !== null && candidate.defaultReasoningEffort !== undefined
        && (typeof candidate.defaultReasoningEffort !== 'string'
          || !efforts.some(effort => effort.id === candidate.defaultReasoningEffort)))) {
      throw catalogError('protocol')
    }
    models.push({
      id: candidate.model,
      name: candidate.displayName,
      ...(typeof candidate.description === 'string' && candidate.description.length > 0
        ? { description: candidate.description }
        : {}),
      ...(efforts.length === 0 ? {} : {
        reasoning: {
          efforts,
          ...(typeof candidate.defaultReasoningEffort === 'string'
            ? { defaultEffort: candidate.defaultReasoningEffort }
            : {}),
        },
      }),
      inputModalities: [...candidate.inputModalities] as string[],
    })
    if (candidate.isDefault) defaultModels.push(candidate.model)
  }
  return { models, defaultModels, nextCursor: result.nextCursor }
}

function displayEffort(value: string): string {
  return value.split(/[-_]/).map(part => part.length === 0 ? part : `${part[0]!.toUpperCase()}${part.slice(1)}`).join(' ')
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) throw catalogError('protocol')
  return value
}

function catalogError(cause: 'protocol' | 'timeout' | 'process-exit'): Error {
  return new Error(`Codex model catalog ${cause}`, { cause })
}

function processExitError(result: CloseResult): Error {
  return new Error(`Codex app-server exited before catalog completion (${result.code ?? 'null'}/${result.signal ?? 'none'})`, {
    cause: 'process-exit',
  })
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Codex model catalog aborted', { cause: 'abort' })
}
