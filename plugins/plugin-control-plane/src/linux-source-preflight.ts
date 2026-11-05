import type { SourceJobRecord } from './source-job-types.js'
import type { SourceBuildDiagnostics } from './source-build-diagnostics.js'

interface NotStarted { runner: object; key: string; consume: () => boolean }
const notStarted = new WeakMap<object, NotStarted>()
/** Internal Host control flow: this build call did not reach execution admission. */
export function linuxSourceNotStarted(cause: unknown, binding: NotStarted): Error {
  const error = new Error(cause instanceof Error ? cause.message : 'Linux source preparation did not start', { cause })
  notStarted.set(error, binding)
  return error
}
export function consumeLinuxSourceNotStarted(error: unknown, binding: Pick<NotStarted, 'runner' | 'key'>): boolean {
  if (!error || typeof error !== 'object') return false
  const proof = notStarted.get(error)
  if (!proof || proof.runner !== binding.runner || proof.key !== binding.key) return false
  try { if (!proof.consume()) return false } catch { return false }
  notStarted.delete(error)
  return true
}
interface Cleaned { id: string; intentDigest: string; revision: number; occurrenceId: string; generation: object; consume: () => boolean }
const cleaned = new WeakMap<object, Cleaned>()
/** Only service-owned successful worktree cleanup may create the terminal proof. */
export function cleanedLinuxSourcePreflight(cause: unknown, job: SourceJobRecord, generation: object, consume: () => boolean = () => true): Error {
  if (!job.occurrenceId || job.status !== 'running') throw new Error('Linux preflight proof requires its original claimed job')
  const error = new Error('Linux source preparation failed before execution admission', { cause })
  cleaned.set(error, { id: job.id, intentDigest: job.intentDigest, revision: job.revision, occurrenceId: job.occurrenceId, generation, consume })
  return error
}
export function consumeCleanedLinuxSourcePreflight(error: unknown, job: SourceJobRecord, generation: object): boolean {
  if (!error || typeof error !== 'object') return false
  const proof = cleaned.get(error)
  if (!proof || proof.generation !== generation || proof.id !== job.id || proof.intentDigest !== job.intentDigest
    || proof.revision !== job.revision || proof.occurrenceId !== job.occurrenceId || job.status !== 'running') return false
  try { if (!proof.consume()) return false } catch { return false }
  cleaned.delete(error)
  return true
}

interface BuildFailed { runner: object; key: string; diagnostics: SourceBuildDiagnostics }
const buildFailed = new WeakMap<object, BuildFailed>()
/**
 * Internal Host control flow: the admitted isolated build reached a terminal,
 * quiescent, non-zero exit under the exact runner contract. The candidate
 * source is deterministically rejected; nothing remains running.
 */
export function linuxSourceBuildFailed(message: string, binding: BuildFailed): Error {
  const error = new Error(message)
  buildFailed.set(error, { runner: binding.runner, key: binding.key, diagnostics: binding.diagnostics })
  return error
}
export function isLinuxSourceBuildFailed(error: unknown): boolean {
  return !!error && typeof error === 'object' && buildFailed.has(error)
}
export function consumeLinuxSourceBuildFailed(error: unknown, binding: Pick<BuildFailed, 'runner' | 'key'>): SourceBuildDiagnostics | undefined {
  if (!error || typeof error !== 'object') return undefined
  const proof = buildFailed.get(error)
  if (!proof || proof.runner !== binding.runner || proof.key !== binding.key) return undefined
  buildFailed.delete(error)
  return proof.diagnostics
}
interface CleanedBuildFailure { id: string; intentDigest: string; revision: number; occurrenceId: string; generation: object; consume: () => SourceBuildDiagnostics | undefined }
const cleanedBuildFailures = new WeakMap<object, CleanedBuildFailure>()
/** Only service-owned successful worktree cleanup may certify a deterministic build failure. */
export function cleanedLinuxSourceBuildFailure(cause: unknown, job: SourceJobRecord, generation: object,
  consume: () => SourceBuildDiagnostics | undefined): Error {
  if (!job.occurrenceId || job.status !== 'running') throw new Error('Linux build failure proof requires its original claimed job')
  const error = new Error('Linux source build failed deterministically', { cause })
  cleanedBuildFailures.set(error, { id: job.id, intentDigest: job.intentDigest, revision: job.revision, occurrenceId: job.occurrenceId, generation, consume })
  return error
}
export function consumeCleanedLinuxSourceBuildFailure(error: unknown, job: SourceJobRecord, generation: object): SourceBuildDiagnostics | undefined {
  if (!error || typeof error !== 'object') return undefined
  const proof = cleanedBuildFailures.get(error)
  if (!proof || proof.generation !== generation || proof.id !== job.id || proof.intentDigest !== job.intentDigest
    || proof.revision !== job.revision || proof.occurrenceId !== job.occurrenceId || job.status !== 'running') return undefined
  let diagnostics: SourceBuildDiagnostics | undefined
  try { diagnostics = proof.consume() } catch { return undefined }
  if (diagnostics === undefined) return undefined
  cleanedBuildFailures.delete(error)
  return diagnostics
}
