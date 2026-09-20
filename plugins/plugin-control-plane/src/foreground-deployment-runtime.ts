import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { ForegroundTaskObservationRegistration } from '@dsh-enhanced/assistant-delivery'
import { captureRetainedDeploymentReadiness } from './deployment-readiness.js'
import { type ForegroundDeploymentRecord } from './foreground-deployment.js'
import { controlPlaneDigest, type ControlPlaneStore } from './store.js'
import type { PluginControlTrustConfig } from './trust.js'
import type { RuntimeObservation } from './runtime-observer-protocol.js'

export interface ForegroundDeploymentConfig { attestorJournalPath: string }

export function validateForegroundDeploymentConfig(value: ForegroundDeploymentConfig): void {
  if (!value || Object.keys(value).join(',') !== 'attestorJournalPath' || typeof value.attestorJournalPath !== 'string'
    || value.attestorJournalPath.length > 4096 || !isAbsolute(value.attestorJournalPath)
    || resolve(value.attestorJournalPath) !== value.attestorJournalPath) throw new Error('invalid foregroundDeployments configuration')
}

/** A changed trust file requires a fresh owning Fiber, never a stale key cache. */
export function foregroundTrustSnapshot(path: string): string {
  if (realpathSync(path) !== path) throw new Error('foreground trust path is not canonical')
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65_536 || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) throw new Error('unsafe foreground trust file')
    return createHash('sha256').update(readFileSync(descriptor)).digest('hex')
  } finally { closeSync(descriptor) }
}

export function createForegroundDeploymentObserver(input: {
  config: ForegroundDeploymentConfig
  profilePath: string
  store: ControlPlaneStore
  trust: PluginControlTrustConfig
  sample(challenge: string): RuntimeObservation
  assertCurrent(): void
  owner: ForegroundTaskObservationRegistration['owner']
}): ForegroundTaskObservationRegistration {
  const capture = (task: ForegroundDeploymentRecord['task']) => {
    input.assertCurrent()
    const runtime = input.sample(randomBytes(32).toString('hex'))
    if (runtime.observedAt < task.dispatchedAt || runtime.observedAt > Date.now()) throw new Error('foreground sample is not current')
    return runtime
  }
  return Object.freeze<ForegroundTaskObservationRegistration>({
    protocol: 'plugin-control-plane/foreground-observer/v1' as const,
    generation: randomUUID(), owner: input.owner,
    begin(task) {
      return input.store.withForegroundDeployment(task, input.profilePath, (plan, operation) => {
        const begin = capture(task)
        if (!operation.receipt) throw new Error('foreground deployment lacks signed readiness')
        const readiness = captureRetainedDeploymentReadiness({ plan, operation, receipt: operation.receipt, trust: input.trust,
          journalPath: input.config.attestorJournalPath, runtime: begin })
        input.assertCurrent()
        input.store.beginForegroundDeployment({ schemaVersion: 1, task: structuredClone(task), readiness, begin, state: 'pending' })
        return task.inboxId
      })
    },
    completed(handle, task, execution) {
      input.assertCurrent()
      if (handle !== task.inboxId) throw new Error('foreground deployment handle differs')
      const prior = input.store.getForegroundDeployment(task.inboxId)
      if (!prior || prior.state !== 'pending' || controlPlaneDigest(prior.task) !== controlPlaneDigest(task)) throw new Error('foreground deployment dispatch differs')
      try {
        input.store.withForegroundDeployment(task, input.profilePath, (plan, operation) => {
          const end = capture(task)
          if (!operation.receipt || !execution.quiescent || execution.status !== 'succeeded') throw new Error('foreground deployment completion unknown')
          const readiness = captureRetainedDeploymentReadiness({ plan, operation, receipt: operation.receipt, trust: input.trust,
            journalPath: input.config.attestorJournalPath, runtime: end })
          if (controlPlaneDigest(readiness) !== controlPlaneDigest(prior.readiness)) throw new Error('foreground deployment changed during execution')
          input.assertCurrent()
          input.store.finishForegroundDeployment({ ...prior, state: 'observed', end, execution: structuredClone(execution) })
        })
      } catch {
        input.assertCurrent()
        input.store.finishForegroundDeployment({ ...prior, state: 'unknown', execution: structuredClone(execution) })
      }
    },
  })
}
