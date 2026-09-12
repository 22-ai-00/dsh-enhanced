import { readFileSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export interface RepairProcessWitness { bootId: string; pid: number; startTicks: string; pidNamespace: string }
export type RepairProcessProbe = 'gone' | 'present' | 'unavailable'

const boot = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const ticks = /^[1-9][0-9]{0,63}$/u
const localBootId = randomUUID()
const namespace = /^(?:linux:[0-9]{1,32}:[0-9]{1,32}|local:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/u

function currentBootId(): string | undefined {
  try { const value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim().toLowerCase(); return boot.test(value) ? value : undefined } catch { return undefined }
}

function startTicks(pid: number): string | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8'), close = raw.lastIndexOf(') ')
    if (close < 0) return undefined
    const fields = raw.slice(close + 2).trim().split(/\s+/u)
    return fields[0] !== 'Z' && ticks.test(fields[19] ?? '') ? fields[19] : undefined
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') return ''
    return undefined
  }
}

function currentPidNamespace(): string | undefined {
  try {
    // stat follows the proc symlink to the namespace inode; lstat would only
    // identify this process's per-procfs symlink entry.
    const stat = statSync('/proc/self/ns/pid')
    const value = `linux:${stat.dev}:${stat.ino}`
    return namespace.test(value) ? value : undefined
  } catch { return undefined }
}

/**
 * Non-Linux gets a process-local identity solely for released same-process
 * reattachment.  It cannot prove a dead prior process, so cold recovery stays
 * conservatively unavailable there.
 */
export function currentRepairProcess(): RepairProcessWitness | undefined {
  const bootId = currentBootId(), pidNamespace = currentPidNamespace(), start = bootId && pidNamespace ? startTicks(process.pid) : undefined
  if (bootId && pidNamespace && start) return { bootId, pid: process.pid, startTicks: start, pidNamespace }
  return process.platform === 'linux' ? undefined : { bootId: localBootId, pid: process.pid, startTicks: String(process.pid), pidNamespace: `local:${localBootId}` }
}

/**
 * Conservative two-read process liveness proof.  "gone" is deliberately
 * narrow: permission errors, zombies, malformed proc data and races are all
 * unavailable, never evidence that a prior tool/model request settled.
 */
export function probeRepairProcess(witness: RepairProcessWitness): RepairProcessProbe {
  if (!boot.test(witness.bootId) || !namespace.test(witness.pidNamespace) || !Number.isSafeInteger(witness.pid) || witness.pid < 1 || !ticks.test(witness.startTicks)) return 'unavailable'
  // PID values are namespace-relative.  A host that cannot prove it observes
  // the same namespace cannot turn a missing/reused PID into a death proof.
  const currentNamespace = currentPidNamespace()
  if (!currentNamespace || currentNamespace !== witness.pidNamespace) return 'unavailable'
  for (let attempt = 0; attempt < 2; attempt++) {
    const bootId = currentBootId()
    if (!bootId) return 'unavailable'
    if (bootId !== witness.bootId) continue
    const start = startTicks(witness.pid)
    if (start === undefined) return 'unavailable'
    if (start !== '' && start === witness.startTicks) return 'present'
    if (start !== '' && start !== witness.startTicks) continue
  }
  // Both reads must agree on an absent process or a different generation.
  const firstBoot = currentBootId(), first = firstBoot ? startTicks(witness.pid) : undefined
  const secondBoot = currentBootId(), second = secondBoot ? startTicks(witness.pid) : undefined
  if (!firstBoot || !secondBoot || first === undefined || second === undefined) return 'unavailable'
  if (firstBoot !== witness.bootId && secondBoot !== witness.bootId) return 'gone'
  if (firstBoot === witness.bootId && secondBoot === witness.bootId
    && ((first === '' && second === '') || (first !== '' && second !== '' && first !== witness.startTicks && second !== witness.startTicks))) return 'gone'
  return 'unavailable'
}
