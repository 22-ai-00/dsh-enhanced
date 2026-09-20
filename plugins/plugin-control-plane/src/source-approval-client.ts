import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { parseApprovalReceipt } from './approval.js'
import { ControlledProcessError, executeControlledProcess } from './adapter-process.js'
import { openTrustedExecutable, verifyOpenTrustedExecutable, type OpenTrustedExecutable } from './trust.js'
import type { ApprovalReceipt } from './types.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const MAX_INPUT_BYTES = 8_192
const MAX_OUTPUT_BYTES = 65_536

export interface SourceApprovalClientConfig {
  executable: { path: string; sha256: string }
  interpreter?: { path: string; sha256: string }
  configPath: string
  timeoutMs: number
}

export interface SourceApprovalRequest {
  protocol: 'dsh-source-approval/v1'
  planId: string
  planDigest: string
  sourceReferenceDigest: string
}

export type SourceApprovalClientErrorCode = 'ABORTED' | 'EXECUTABLE_CHANGED' | 'FAILED' | 'INVALID_CONFIG' | 'OUTPUT_LIMIT' | 'TIMEOUT'

export class SourceApprovalClientError extends Error {
  constructor(readonly code: SourceApprovalClientErrorCode, message: string) {
    super(`plugin-control-plane source-approval-client[${code}]: ${message}`)
    this.name = 'SourceApprovalClientError'
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SourceApprovalClientError('INVALID_CONFIG', `${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  if (Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) {
    throw new SourceApprovalClientError('INVALID_CONFIG', `${label} has unknown or missing fields`)
  }
}

function canonicalPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 2_000
    || value.normalize('NFC') !== value || value.trim() !== value || [...value].some(character => {
      const point = character.codePointAt(0)!
      return point <= 0x1f || point === 0x7f
    }) || !isAbsolute(value) || resolve(value) !== value) {
    throw new SourceApprovalClientError('INVALID_CONFIG', `${label} must be an absolute canonical path`)
  }
  return value
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new SourceApprovalClientError('INVALID_CONFIG', `${label} must be a lowercase sha256 digest`)
  return value
}

function executable(value: unknown, label: string): { path: string; sha256: string } {
  const item = object(value, label)
  exactKeys(item, ['path', 'sha256'], label)
  return Object.freeze({ path: canonicalPath(item.path, `${label}.path`), sha256: sha256(item.sha256, `${label}.sha256`) })
}

export function validateSourceApprovalClientConfig(value: unknown): asserts value is SourceApprovalClientConfig {
  const item = object(value, 'source approval client config')
  const allowed = new Set(['executable', 'interpreter', 'configPath', 'timeoutMs'])
  if (Object.keys(item).some(key => !allowed.has(key)) || !('executable' in item) || !('configPath' in item) || !('timeoutMs' in item)) {
    throw new SourceApprovalClientError('INVALID_CONFIG', 'source approval client config has unknown or missing fields')
  }
  executable(item.executable, 'executable')
  if (item.interpreter !== undefined) executable(item.interpreter, 'interpreter')
  canonicalPath(item.configPath, 'configPath')
  if (!Number.isSafeInteger(item.timeoutMs) || Number(item.timeoutMs) < 1 || Number(item.timeoutMs) > 10_000) {
    throw new SourceApprovalClientError('INVALID_CONFIG', 'timeoutMs must be an integer from 1 through 10000')
  }
}

export interface SourceAuthorityRequest extends Omit<SourceApprovalRequest, 'protocol'> {
  protocol: 'dsh-source-approval/v1' | 'dsh-source-release-authorization/v1' | 'dsh-source-adoption/v1'
}

function assertRequest(value: unknown): asserts value is SourceAuthorityRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== ['planDigest', 'planId', 'protocol', 'sourceReferenceDigest'].join(',')) {
    throw new SourceApprovalClientError('FAILED', 'source approval request is invalid')
  }
  const item = value as Record<string, unknown>
  if (!['dsh-source-approval/v1', 'dsh-source-release-authorization/v1', 'dsh-source-adoption/v1'].includes(String(item.protocol)) || typeof item.planId !== 'string' || typeof item.planDigest !== 'string'
    || typeof item.sourceReferenceDigest !== 'string' || !ID.test(item.planId)
    || !DIGEST.test(item.planDigest) || !DIGEST.test(item.sourceReferenceDigest)) {
    throw new SourceApprovalClientError('FAILED', 'source approval request is invalid')
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SourceApprovalClientError('ABORTED', 'source approval request was aborted')
}

async function execute(executable: OpenTrustedExecutable, interpreter: OpenTrustedExecutable | undefined,
  configPath: string, input: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  if (process.platform !== 'linux') throw new SourceApprovalClientError('FAILED', 'descriptor-pinned source approval requires Linux')
  try { await realpath('/proc/self/fd') } catch {
    throw new SourceApprovalClientError('FAILED', 'descriptor-pinned source approval requires /proc/self/fd')
  }
  const command = interpreter === undefined ? '/proc/self/fd/3' : '/proc/self/fd/4'
  const args = interpreter === undefined ? ['--config', configPath] : ['/proc/self/fd/3', '--config', configPath]
  const stdio: Array<'pipe' | 'ignore' | number> = ['pipe', 'pipe', 'ignore', executable.handle.fd]
  if (interpreter !== undefined) stdio.push(interpreter.handle.fd)
  try {
    return await executeControlledProcess({ command, args,
      // The authority reads its own owner-private config.  No caller
      // environment, credentials, or model/provider settings cross this edge.
      env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' },
      stdio, stdin: input, timeoutMs, maximumOutput: MAX_OUTPUT_BYTES, ...(signal ? { signal } : {}) })
  } catch (error) {
    if (!(error instanceof ControlledProcessError)) throw error
    if (error.code === 'ABORTED') throw new SourceApprovalClientError('ABORTED', 'source authority request was aborted')
    if (error.code === 'TIMEOUT') throw new SourceApprovalClientError('TIMEOUT', 'source approval authority exceeded its deadline')
    if (error.code === 'OUTPUT_LIMIT') throw new SourceApprovalClientError('OUTPUT_LIMIT', 'source approval authority exceeded its output bound')
    throw new SourceApprovalClientError('FAILED', error.code === 'NON_ZERO'
      ? 'source approval authority returned a non-zero status' : 'source approval authority could not be safely reclaimed')
  }
}

// Shared descriptor-pinned transport; protocol-specific wrappers validate the receipt.
export async function requestSourceAuthorityReceipt<T>(config: SourceApprovalClientConfig, request: SourceAuthorityRequest,
  parseReceipt: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
  assertRequest(request)
  return requestPinnedAuthorityReceipt(config, request, parseReceipt, signal)
}

export async function requestPinnedAuthorityReceipt<T>(config: SourceApprovalClientConfig, request: unknown,
  parseReceipt: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
  validateSourceApprovalClientConfig(config)
  assertNotAborted(signal)
  const input = JSON.stringify(request)
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new SourceApprovalClientError('FAILED', 'source approval request exceeds its input bound')
  let executable: OpenTrustedExecutable | undefined
  let interpreter: OpenTrustedExecutable | undefined
  try {
    executable = await openTrustedExecutable(config.executable.path, config.executable.sha256)
    interpreter = config.interpreter === undefined ? undefined
      : await openTrustedExecutable(config.interpreter.path, config.interpreter.sha256)
    assertNotAborted(signal)
    const output = await execute(executable, interpreter, config.configPath, input, config.timeoutMs, signal)
    await verifyOpenTrustedExecutable(executable)
    if (interpreter !== undefined) await verifyOpenTrustedExecutable(interpreter)
    assertNotAborted(signal)
    let parsed: unknown
    try { parsed = JSON.parse(output) as unknown } catch {
      throw new SourceApprovalClientError('FAILED', 'source approval authority did not return one JSON receipt')
    }
    return parseReceipt(parsed)
  } catch (error) {
    if (error instanceof SourceApprovalClientError) throw error
    throw new SourceApprovalClientError('EXECUTABLE_CHANGED', 'source approval executable descriptor identity could not be retained')
  } finally {
    try { await interpreter?.handle.close() }
    finally { await executable?.handle.close() }
  }
}


export async function requestSourceApproval(config: SourceApprovalClientConfig, request: SourceApprovalRequest,
  signal?: AbortSignal): Promise<ApprovalReceipt> {
  if (request?.protocol !== 'dsh-source-approval/v1') throw new SourceApprovalClientError('FAILED', 'source approval request protocol is invalid')
  return requestSourceAuthorityReceipt(config, request, parsed => {
    let receipt: ApprovalReceipt
    try { receipt = parseApprovalReceipt(parsed) } catch {
      throw new SourceApprovalClientError('FAILED', 'source approval authority returned an invalid approval receipt')
    }
    if (receipt.decision !== 'approved' || receipt.planId !== request.planId || receipt.planDigest !== request.planDigest) {
      throw new SourceApprovalClientError('FAILED', 'source approval receipt is not an approval for this exact plan and digest')
    }
    return receipt
  }, signal)
}
