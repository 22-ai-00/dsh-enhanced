import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import { normalizeForegroundTerminationObservation, type ForegroundTerminationObservation } from './foreground-termination.js'

/** Facts owned by the Host, never an exception message or model-authored text. */
export type NativeTerminationCause = 'runtime-error' | 'execution-timeout' | 'owner-stop'
  | 'owner-new-session' | 'lease-or-authority-lost' | 'host-disposed' | 'execution-aborted'

export function observeNativeTermination(input: {
  producer: ForegroundTerminationObservation['producer']
  reason?: TurnEndReason | undefined
  cause?: NativeTerminationCause | undefined
  handleDisposed: boolean
  completed: boolean
}): Readonly<ForegroundTerminationObservation> {
  let kind: ForegroundTerminationObservation['kind'] = 'unknown'
  let causeCode: ForegroundTerminationObservation['causeCode'] = 'turn-missing'
  const reason = input.reason
  if (input.completed && input.handleDisposed) {
    kind = 'completed'; causeCode = 'turn-completed'
  } else if (input.cause === 'owner-stop' || input.cause === 'owner-new-session') {
    kind = 'owner-cancelled'; causeCode = input.cause
  } else if (reason?.kind === 'aborted' && reason.reason.kind === 'user') {
    kind = 'owner-cancelled'; causeCode = 'turn-user-aborted'
  } else if (input.cause === 'execution-timeout') {
    kind = 'timeout'; causeCode = input.cause
  } else if (input.cause === 'lease-or-authority-lost' || input.cause === 'host-disposed'
    || input.cause === 'execution-aborted') {
    kind = 'interrupted'; causeCode = input.cause
  } else if (reason?.kind === 'error') {
    kind = 'error'; causeCode = 'turn-error'
  } else if (reason?.kind === 'max-tokens') {
    kind = 'error'; causeCode = 'turn-max-tokens'
  } else if (reason?.kind === 'aborted') {
    kind = 'interrupted'; causeCode = 'turn-aborted'
  } else if (input.cause === 'runtime-error') {
    kind = 'error'; causeCode = input.cause
  } else if (!input.handleDisposed) {
    causeCode = 'teardown-unconfirmed'
  } else if (reason?.kind === 'completed') {
    causeCode = 'completion-unconfirmed'
  } else if (reason !== undefined) {
    causeCode = 'turn-unclassified'
  }
  return normalizeForegroundTerminationObservation({
    protocol: 'assistant-delivery/foreground-termination/v1', producer: input.producer,
    kind, causeCode, handleDisposed: input.handleDisposed, effects: 'unknown', replay: 'forbidden',
  })
}
