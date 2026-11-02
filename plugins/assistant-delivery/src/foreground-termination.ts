import { types } from 'node:util'
/** Host observation only: no business-success claim and no replay authorization. */
export const foregroundTerminationKinds = Object.freeze({
  'turn-completed': 'completed',
  'turn-error': 'error',
  'turn-max-tokens': 'error',
  'runtime-error': 'error',
  'execution-timeout': 'timeout',
  'turn-user-aborted': 'owner-cancelled',
  'owner-stop': 'owner-cancelled',
  'owner-new-session': 'owner-cancelled',
  'turn-aborted': 'interrupted',
  'lease-or-authority-lost': 'interrupted',
  'host-disposed': 'interrupted',
  'execution-aborted': 'interrupted',
  'turn-missing': 'unknown',
  'teardown-unconfirmed': 'unknown',
  'completion-unconfirmed': 'unknown',
  'turn-unclassified': 'unknown',
} as const)
export type ForegroundTerminationCauseCode = keyof typeof foregroundTerminationKinds
export interface ForegroundTerminationObservation {
  readonly protocol: 'assistant-delivery/foreground-termination/v1'
  readonly producer: 'delivery-agent' | 'native-web'
  readonly kind: typeof foregroundTerminationKinds[ForegroundTerminationCauseCode]
  readonly causeCode: ForegroundTerminationCauseCode
  readonly handleDisposed: boolean
  readonly effects: 'unknown'
  readonly replay: 'forbidden'
}
export function normalizeForegroundTerminationObservation(value: unknown): Readonly<ForegroundTerminationObservation> {
  const fail = (): never => { throw new Error('foreground termination observation is invalid') }
  const keys = ['protocol','producer','kind','causeCode','handleDisposed','effects','replay']
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length) fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.keys(descriptors).sort().join('\0') !== keys.sort().join('\0')
    || !Object.values(descriptors).every(item => item.enumerable && 'value' in item)) fail()
  const v = value as Record<string, unknown>
  if (v.protocol !== 'assistant-delivery/foreground-termination/v1'
    || typeof v.producer !== 'string' || !['delivery-agent','native-web'].includes(v.producer)
    || typeof v.causeCode !== 'string' || !Object.hasOwn(foregroundTerminationKinds, v.causeCode)
    || v.kind !== foregroundTerminationKinds[v.causeCode as ForegroundTerminationCauseCode]
    || typeof v.handleDisposed !== 'boolean' || v.effects !== 'unknown' || v.replay !== 'forbidden') fail()
  return Object.freeze({ protocol: 'assistant-delivery/foreground-termination/v1', producer: v.producer as ForegroundTerminationObservation['producer'],
    kind: v.kind as ForegroundTerminationObservation['kind'], causeCode: v.causeCode as ForegroundTerminationCauseCode,
    handleDisposed: v.handleDisposed as boolean, effects: 'unknown', replay: 'forbidden' })
}
