import type { IsolationControllerAuthority } from './ledger.js'
import type { LinuxRepositoryRunnerRequest } from './linux-repository-runner.js'

interface LedgerBinding {
  ledger: object
  key: string
  requestDigest: string
  authority: IsolationControllerAuthority
}
const ledgerRefusals = new WeakMap<object, LedgerBinding & { attempt: object }>()
const ledgerAttempts = new WeakMap<object, object>()
export function withLinuxLedgerAdmissionAttempt<T>(ledger: object, attempt: object, operation: () => T): T {
  const previous = ledgerAttempts.get(ledger)
  ledgerAttempts.set(ledger, attempt)
  try { return operation() } finally { if (previous) ledgerAttempts.set(ledger, previous); else ledgerAttempts.delete(ledger) }
}
const sameAuthority = (a: IsolationControllerAuthority, b: IsolationControllerAuthority): boolean => a.ownerId === b.ownerId && a.fence === b.fence

/** Internal: only prepare's explicitly rejected, successfully rolled-back transaction may mark its error. */
export function markLinuxLedgerAdmissionRefusal(error: object, binding: LedgerBinding): void {
  const attempt = ledgerAttempts.get(binding.ledger)
  if (attempt) ledgerRefusals.set(error, { ...binding, attempt, authority: { ...binding.authority } })
}
export function consumeLinuxLedgerAdmissionRefusal(error: unknown, binding: LedgerBinding & { attempt: object }): boolean {
  if (!error || typeof error !== 'object') return false
  const proof = ledgerRefusals.get(error)
  if (!proof || proof.ledger !== binding.ledger || proof.key !== binding.key || proof.requestDigest !== binding.requestDigest
    || !sameAuthority(proof.authority, binding.authority) || proof.attempt !== binding.attempt) return false
  ledgerRefusals.delete(error)
  return true
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}
interface RunnerBinding {
  runner: object
  key: string
  request: LinuxRepositoryRunnerRequest
  current: () => boolean
}
const runnerRefusals = new WeakMap<object, Omit<RunnerBinding, 'request'> & { request: string }>()
/** Internal: this error is a statement about one completed call, never missing historical state. */
export function linuxRepositoryAdmissionRefusal(cause: unknown, binding: RunnerBinding): Error {
  const error = new Error(cause instanceof Error ? cause.message : 'Linux repository admission refused', { cause })
  runnerRefusals.set(error, { ...binding, request: canonical(binding.request) })
  return error
}
/** Host-only, single-use proof. JSON, arbitrary errors, another runner/request or a stale controller cannot qualify. */
export function consumeLinuxRepositoryAdmissionRefusal(error: unknown, runner: object, key: string, request: LinuxRepositoryRunnerRequest): boolean {
  if (!error || typeof error !== 'object') return false
  const proof = runnerRefusals.get(error)
  if (!proof || proof.runner !== runner || proof.key !== key || proof.request !== canonical(request)) return false
  try { if (!proof.current()) return false } catch { return false }
  runnerRefusals.delete(error)
  return true
}
