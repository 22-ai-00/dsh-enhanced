import { queryRuntimeObserver, runtimeConfigDigest, type RuntimeObserverConfig, type RuntimeObservation } from '@dsh-enhanced/plugin-control-plane'
import { setTimeout as delay } from 'node:timers/promises'
import { inspectNativeLaunchd } from './launchd-identity.js'
export { assertNativeLaunchdPlist, inspectNativeLaunchd, startNativeLaunchd, stopNativeLaunchd } from './launchd-identity.js'
export type { NativeLaunchdCommand, NativeLaunchdCommandResult, NativeLaunchdIdentity, NativeLaunchdState } from './launchd-identity.js'
import type { NativeLaunchdIdentity } from './launchd-identity.js'

function fail(message: string): never { throw new Error(`rsi native launchd: ${message}`) }

export function assertNativeRuntimeObservation(value: RuntimeObservation, observer: RuntimeObserverConfig, pid: number,
  now = Date.now()): void {
  if (pid < 2 || value.processId !== pid || value.profilePath !== observer.profilePath
    || value.observerConfigDigest !== runtimeConfigDigest(observer) || Math.abs(now - value.observedAt) > 5_000
    || value.entries.length !== observer.targets.length) fail('runtime observation differs from the loaded Host')
  for (const target of observer.targets) {
    const entry = value.entries.find(item => item.entryId === target.entryId)
    if (!entry?.active || entry.module !== target.module || entry.configDigest !== target.configDigest
      || target.services.some(name => !entry.services.some(service => service.name === name && service.instance !== null))) {
      fail(`Loader entry ${target.entryId} is not ready`)
    }
  }
}

export async function waitNativeRuntimeReady(input: NativeLaunchdIdentity, observer: RuntimeObserverConfig,
  signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 60_000
  let stableSince = 0, previous = '', failure: unknown
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    try {
      const before = inspectNativeLaunchd(input)
      const value = await queryRuntimeObserver({ ...observer, signal })
      const after = inspectNativeLaunchd(input)
      if (!before.registered || !after.registered || before.pid !== after.pid) fail('Host changed during runtime observation')
      assertNativeRuntimeObservation(value, observer, after.pid)
      const key = JSON.stringify([after.pid, value.observerId, value.entries.map(entry => [entry.entryId, entry.instance, entry.services])])
      if (key !== previous) { previous = key; stableSince = Date.now() }
      if (Date.now() - stableSince >= 12_000) return
    } catch (error) { signal.throwIfAborted(); failure = error; stableSince = 0; previous = '' }
    await delay(500, undefined, { signal })
  }
  throw new Error('rsi native launchd: Host failed the stable Loader readiness check', { cause: failure })
}
