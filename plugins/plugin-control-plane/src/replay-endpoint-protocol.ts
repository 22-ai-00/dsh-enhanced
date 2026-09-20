import { randomBytes } from 'node:crypto'
import { assertReplayGrant, validateReplaySignedAuthority, type ReplayGrant, type ReplaySignedAuthority } from './replay-grant.js'
import { lstatSync, realpathSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, isAbsolute, resolve } from 'node:path'
import { replayRuntimeDigest, validateReplayCases, type EffectBlockedReplayResult, type ReplayCase } from './effect-blocked-replay.js'
import { assertRuntimeObservation, assertRuntimeObserverExact as exact, assertRuntimeObserverText as text,
  equalRuntimeObserverMac, privateRuntimeObserverDirectory, readPrivateRuntimeObserverKey, runtimeConfigDigest,
  runtimeObserverMac, validateRuntimeObserverConfig, type RuntimeObserverConfig } from './runtime-observer-protocol.js'

export interface ReplayFixedAuthority {
  operationId: string; requestDigest: string; notBefore: number; expiresAt: number; cases: ReplayCase[]
}
export interface ReplayEndpointConfig {
  runtime: RuntimeObserverConfig
  journalPath: string
  authority: ReplayFixedAuthority | ReplaySignedAuthority
  agent: { cwd: string; preset: string; provider: string; model: string }
  timeoutMs: number
}
interface ReplayEndpointRequestBase {
  action: 'execute' | 'query'
  operationId: string
  requestDigest: string
  challenge: string
}
export type ReplayEndpointRequest = ReplayEndpointRequestBase & (
  | { schemaVersion: 1 }
  | { schemaVersion: 2; grant: ReplayGrant }
)
export interface ReplayEndpointResponse {
  schemaVersion: 1
  challenge: string
  operationId: string
  requestDigest: string
  status: 'not-started' | 'unknown' | 'completed' | 'stale'
  result: EffectBlockedReplayResult | null
  observedAt: number
}
export const REPLAY_MAX_BYTES = 131_072
export const REPLAY_REQUEST_MAX_BYTES = 65_536
export const REPLAY_REQUEST_DOMAIN = 'dsh-effect-replay-request/v1'
export const REPLAY_RESPONSE_DOMAIN = 'dsh-effect-replay-response/v1'
const HEX = /^[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u
export function replayEndpointFail(): never { throw new Error('replay endpoint: invalid authority, request or observation') }

export function validateReplayEndpointConfig(value: unknown): asserts value is ReplayEndpointConfig {
  runtimeConfigDigest(value)
  exact(value, ['runtime', 'journalPath', 'authority', 'agent', 'timeoutMs'])
  validateRuntimeObserverConfig(value.runtime)
  const runtime = value.runtime
  if (typeof value.journalPath !== 'string' || !isAbsolute(value.journalPath) || resolve(value.journalPath) !== value.journalPath
    || value.journalPath === runtime.profilePath || value.journalPath.startsWith(runtime.profilePath + '/')
    || value.journalPath === runtime.socketPath || value.journalPath === runtime.keyPath) replayEndpointFail()
  privateRuntimeObserverDirectory(dirname(value.journalPath))
  if (isReplaySignedAuthority(value.authority)) {
    validateReplaySignedAuthority(value.authority)
    if (value.authority.scope.profile.path !== runtime.profilePath) replayEndpointFail()
  } else {
    exact(value.authority, ['operationId', 'requestDigest', 'notBefore', 'expiresAt', 'cases'])
    text(value.authority.operationId, ID); text(value.authority.requestDigest, HEX)
    for (const key of ['notBefore', 'expiresAt']) if (!Number.isSafeInteger(value.authority[key]) || (value.authority[key] as number) <= 0) replayEndpointFail()
    if ((value.authority.expiresAt as number) <= (value.authority.notBefore as number)
      || (value.authority.expiresAt as number) - (value.authority.notBefore as number) > 86_400_000) replayEndpointFail()
    validateReplayCases(value.authority.cases)
  }
  exact(value.agent, ['cwd', 'preset', 'provider', 'model'])
  if (typeof value.agent.cwd !== 'string' || !isAbsolute(value.agent.cwd) || realpathSync(value.agent.cwd) !== value.agent.cwd
    || !lstatSync(value.agent.cwd).isDirectory()) replayEndpointFail()
  for (const key of ['preset', 'provider', 'model']) {
    text(value.agent[key], /^\S{1,160}$/u)
    if (Array.from(value.agent[key] as string).some(char => char.charCodeAt(0) < 33)) replayEndpointFail()
  }
  if (!Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 100 || (value.timeoutMs as number) > 60_000) replayEndpointFail()
}

export function isReplaySignedAuthority(value: unknown): value is ReplaySignedAuthority {
  return typeof value === 'object' && value !== null && 'mode' in value && value.mode === 'signed'
}

export function assertReplayEndpointRequest(value: unknown): asserts value is ReplayEndpointRequest {
  runtimeConfigDigest(value)
  const signed = typeof value === 'object' && value !== null && 'schemaVersion' in value && value.schemaVersion === 2
  exact(value, ['schemaVersion', 'action', 'operationId', 'requestDigest', 'challenge', ...(signed ? ['grant'] : [])])
  if ((!signed && value.schemaVersion !== 1) || !['execute', 'query'].includes(value.action as string)) replayEndpointFail()
  if (signed) assertReplayGrant(value.grant)
  text(value.operationId, ID); text(value.requestDigest, HEX); text(value.challenge, HEX)
}

export function assertReplayEndpointResponse(value: unknown): asserts value is ReplayEndpointResponse {
  exact(value, ['schemaVersion', 'challenge', 'operationId', 'requestDigest', 'status', 'result', 'observedAt'])
  if (value.schemaVersion !== 1 || !['not-started', 'unknown', 'completed', 'stale'].includes(value.status as string)
    || !Number.isSafeInteger(value.observedAt) || (value.observedAt as number) <= 0) replayEndpointFail()
  text(value.challenge, HEX); text(value.operationId, ID); text(value.requestDigest, HEX)
  if (value.status !== 'completed') { if (value.result !== null) replayEndpointFail(); return }
  const result = value.result
  exact(result, ['schemaVersion', 'kind', 'operationId', 'requestDigest', 'caseDigest', 'sessionId', 'runtime', 'runtimeDigest', 'attempts', 'completedAt', 'quiescent'])
  runtimeConfigDigest(result)
  if (result.schemaVersion !== 1 || result.kind !== 'dsh-effect-blocked-replay-observation' || result.quiescent !== true
    || result.operationId !== value.operationId || result.requestDigest !== value.requestDigest
    || typeof result.sessionId !== 'string' || result.sessionId.length > 256
    || !Number.isSafeInteger(result.completedAt) || (result.completedAt as number) <= 0
    || (result.completedAt as number) > (value.observedAt as number)) replayEndpointFail()
  text(result.caseDigest, HEX); text(result.runtimeDigest, HEX); assertRuntimeObservation(result.runtime)
  if (replayRuntimeDigest(result.runtime) !== result.runtimeDigest || !result.runtime.entries.every(entry => entry.active)
    || result.runtime.observedAt > (result.completedAt as number)) replayEndpointFail()
  if (!Array.isArray(result.attempts) || result.attempts.length < 2 || result.attempts.length > 32) replayEndpointFail()
  const ids = new Set<string>(), kinds = new Set<string>()
  for (const attempt of result.attempts) {
    exact(attempt, ['caseId', 'kind', 'callId', 'inputDigest', 'blockedAt', 'observedAt', 'resultDigest'])
    text(attempt.caseId, ID); text(attempt.inputDigest, HEX); text(attempt.resultDigest, HEX)
    if (!['tool', 'delivery'].includes(attempt.kind as string) || attempt.callId !== `${result.operationId}:${attempt.caseId}`
      || attempt.blockedAt !== (attempt.kind === 'tool' ? 'native-tool-guard' : 'delivery-reply-admission')
      || !Number.isSafeInteger(attempt.observedAt) || (attempt.observedAt as number) < result.runtime.observedAt
      || (attempt.observedAt as number) > (result.completedAt as number) || ids.has(attempt.caseId)) replayEndpointFail()
    ids.add(attempt.caseId); kinds.add(attempt.kind as string)
  }
  if (kinds.size !== 2) replayEndpointFail()
}

/** Explicit execute or read-only query; disconnect/timeout never causes an automatic retry. */
export async function queryReplayEndpoint(input: { socketPath: string; keyPath: string; action: 'execute' | 'query';
  operationId: string; requestDigest: string; grant?: ReplayGrant; timeoutMs: number; signal?: AbortSignal }): Promise<ReplayEndpointResponse> {
  if (process.platform !== 'linux' || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 65_000) replayEndpointFail()
  privateRuntimeObserverDirectory(dirname(input.socketPath))
  const before = lstatSync(input.socketPath)
  if (!before.isSocket() || before.uid !== process.getuid!() || (before.mode & 0o077) !== 0 || realpathSync(input.socketPath) !== input.socketPath) replayEndpointFail()
  const request: ReplayEndpointRequest = { ...(input.grant ? { schemaVersion: 2 as const, grant: input.grant } : { schemaVersion: 1 as const }), action: input.action, operationId: input.operationId,
    requestDigest: input.requestDigest, challenge: randomBytes(32).toString('hex') }
  assertReplayEndpointRequest(request)
  if (Buffer.byteLength(JSON.stringify(request)) + 100 > REPLAY_REQUEST_MAX_BYTES) replayEndpointFail()
  const key = readPrivateRuntimeObserverKey(input.keyPath)
  const signal = AbortSignal.any([AbortSignal.timeout(input.timeoutMs), ...(input.signal ? [input.signal] : [])])
  try {
    return await new Promise<ReplayEndpointResponse>((resolveReply, reject) => {
      const socket = createConnection({ path: input.socketPath, signal })
      let bytes = Buffer.alloc(0), settled = false
      const finish = (error?: Error, response?: ReplayEndpointResponse) => {
        if (settled) return
        settled = true; socket.destroy()
        if (error) reject(error); else resolveReply(response!)
      }
      socket.once('error', error => finish(error))
      socket.once('connect', () => socket.end(JSON.stringify({ request, mac: runtimeObserverMac(key, REPLAY_REQUEST_DOMAIN, request) }) + '\n'))
      socket.on('data', chunk => {
        if (bytes.length + chunk.length > REPLAY_MAX_BYTES) { finish(new Error('replay endpoint response too large')); return }
        bytes = Buffer.concat([bytes, chunk])
      })
      socket.once('end', () => {
        try {
          if (bytes.at(-1) !== 10 || bytes.subarray(0, -1).includes(10)) replayEndpointFail()
          const envelope: unknown = JSON.parse(bytes.toString('utf8'))
          exact(envelope, ['response', 'mac'])
          if (!equalRuntimeObserverMac(envelope.mac, runtimeObserverMac(key, REPLAY_RESPONSE_DOMAIN, envelope.response))) replayEndpointFail()
          const response = envelope.response
          assertReplayEndpointResponse(response)
          if (response.challenge !== request.challenge || response.operationId !== input.operationId || response.requestDigest !== input.requestDigest) replayEndpointFail()
          const after = lstatSync(input.socketPath)
          if (after.ino !== before.ino || after.dev !== before.dev || !after.isSocket() || (after.mode & 0o077) !== 0 || after.uid !== before.uid) replayEndpointFail()
          finish(undefined, response)
        } catch { finish(new Error('replay endpoint response rejected')) }
      })
      socket.once('close', () => { if (!settled) finish(new Error('replay endpoint closed before response')) })
    })
  } finally { key.fill(0) }
}
