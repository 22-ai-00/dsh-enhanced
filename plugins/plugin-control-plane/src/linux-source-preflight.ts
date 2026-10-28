import type { SourceJobRecord } from './source-job-types.js'

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
