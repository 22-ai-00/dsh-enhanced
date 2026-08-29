import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { isAgentLoopRequest, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AgentLoopRequestAttestor } from '@dsh-enhanced/llm-route-capabilities'

export interface LiveSessionCwd {
  readonly id: NonNullable<GenerateOptions['sessionId']>
  readonly header: { readonly cwd?: string }
}

export interface LiveSessionLookup {
  get(id: NonNullable<GenerateOptions['sessionId']>): LiveSessionCwd | undefined
}

export class TrustedSessionCwdError extends Error {
  constructor() {
    super('local provider requires a matching live loop session and canonical cwd')
  }
}

function canonicalDirectory(path: string): string {
  if (!isAbsolute(path)) throw new TrustedSessionCwdError()
  try {
    return realpathSync.native(path)
  } catch {
    throw new TrustedSessionCwdError()
  }
}

function ownEnumerableDataField(value: object, key: string): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined) return undefined
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TrustedSessionCwdError()
  return descriptor
}

/**
 * Resolves the only cwd a local coding process may receive for this request.
 * A same-module marker or the Host-owned exact live-agent proof is mandatory;
 * copied request fields or a persisted/stale session id cannot select a path.
 */
export function resolveTrustedSessionCwd(input: {
  request: GenerateOptions
  configuredCwd: string
  sessions: LiveSessionLookup | undefined
  attestor?: AgentLoopRequestAttestor
}): string {
  const sessionId = ownEnumerableDataField(input.request, 'sessionId')?.value as GenerateOptions['sessionId']
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 512) {
    throw new TrustedSessionCwdError()
  }
  const session = input.sessions?.get(sessionId)
  if (session === undefined || session.id !== sessionId || typeof session.header.cwd !== 'string') {
    throw new TrustedSessionCwdError()
  }
  const purpose = ownEnumerableDataField(input.request, 'purpose')
  const hasPurpose = purpose !== undefined
  const loopOwned = hasPurpose
    ? purpose.value === 'compaction'
      && input.attestor?.claimCompaction?.(input.request, session) === true
      && Object.isFrozen(input.request)
    : Object.isFrozen(input.request)
      && (isAgentLoopRequest(input.request) || input.attestor?.claim(input.request, session) === true)
  if (!loopOwned) throw new TrustedSessionCwdError()
  const configuredCwd = canonicalDirectory(input.configuredCwd)
  const sessionCwd = canonicalDirectory(session.header.cwd)
  if (configuredCwd !== sessionCwd) throw new TrustedSessionCwdError()
  return sessionCwd
}
