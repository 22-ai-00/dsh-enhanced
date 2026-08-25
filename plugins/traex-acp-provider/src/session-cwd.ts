import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { isAgentLoopRequest, type GenerateOptions } from '@deepseek-ai/dsh-llm'

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

/**
 * Resolves the only cwd a local ACP process may receive for this request.
 * The marker is process-local and the session lookup is live, so copied request
 * fields or a persisted/stale session id cannot select an arbitrary directory.
 */
export function resolveTrustedSessionCwd(input: {
  request: GenerateOptions
  configuredCwd: string
  sessions: LiveSessionLookup | undefined
}): string {
  const sessionId = input.request.sessionId
  if (sessionId === undefined || !Object.isFrozen(input.request) || !isAgentLoopRequest(input.request)) {
    throw new TrustedSessionCwdError()
  }
  const session = input.sessions?.get(sessionId)
  if (session === undefined || session.id !== sessionId || typeof session.header.cwd !== 'string') {
    throw new TrustedSessionCwdError()
  }
  const configuredCwd = canonicalDirectory(input.configuredCwd)
  const sessionCwd = canonicalDirectory(session.header.cwd)
  if (configuredCwd !== sessionCwd) throw new TrustedSessionCwdError()
  return sessionCwd
}
