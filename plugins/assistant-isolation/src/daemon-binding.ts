import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { processWitness } from './runtime-witness.js'
import type { DaemonWitness } from './runtime-witness.js'

export interface SystemdBinding { kind: 'systemd'; serviceInvocationId: string; socketInvocationId: string }

const systemctl = '/usr/bin/systemctl'
const outputMaximum = 16_384
const invocationId = /^[0-9a-f]{32}$/
const pid = /^[1-9][0-9]*$/
const properties = ['MainPID', 'InvocationID', 'ActiveState', 'SubState', 'TriggeredBy', 'Triggers', 'Listen', 'ExecStart'] as const
type Unit = Record<(typeof properties)[number], string>
const required = {
  'docker.service': ['MainPID', 'InvocationID', 'ActiveState', 'SubState', 'TriggeredBy', 'ExecStart'],
  'docker.socket': ['InvocationID', 'ActiveState', 'SubState', 'Triggers', 'Listen'],
} as const

function equalUnit(left: Unit, right: Unit): boolean { return properties.every(key => left[key] === right[key]) }
function includesUnit(value: string, unit: string): boolean { return value.split(/\s+/).includes(unit) }

async function show(unit: 'docker.service' | 'docker.socket'): Promise<Unit | undefined> {
  return await new Promise(resolve => {
    let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let complete = false; let timeout: NodeJS.Timeout | undefined
    const finish = (value: Unit | undefined): void => { if (complete) return; complete = true; if (timeout !== undefined) clearTimeout(timeout); resolve(value) }
    let child: ReturnType<typeof spawn>
    try { child = spawn(systemctl, ['show', unit, ...properties.map(property => `--property=${property}`)], { shell: false, env: { LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch { finish(undefined); return }
    const collect = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      const bytes = stdout.length + stderr.length + chunk.length
      if (bytes > outputMaximum) { child.kill('SIGKILL'); finish(undefined); return }
      if (target === 'stdout') stdout = Buffer.concat([stdout, chunk]); else stderr = Buffer.concat([stderr, chunk])
    }
    child.stdout?.on('data', chunk => collect('stdout', chunk))
    child.stderr?.on('data', chunk => collect('stderr', chunk))
    child.once('error', () => finish(undefined))
    child.once('close', code => {
      if (code !== 0 || stderr.length !== 0) { finish(undefined); return }
      const values = new Map<string, string>()
      for (const line of stdout.toString('utf8').split('\n').filter(Boolean)) {
        const separator = line.indexOf('='); if (separator <= 0) { finish(undefined); return }
        const key = line.slice(0, separator); const value = line.slice(separator + 1)
        if (!properties.includes(key as (typeof properties)[number]) || values.has(key)) { finish(undefined); return }
        values.set(key, value)
      }
      if (required[unit].some(property => !values.has(property))) { finish(undefined); return }
      finish(Object.fromEntries(properties.map(property => [property, values.get(property) ?? ''])) as Unit)
    })
    timeout = setTimeout(() => { child.kill('SIGKILL'); finish(undefined) }, 5_000)
    timeout.unref()
  })
}

function matches(daemon: DaemonWitness, service: Unit, socket: Unit): SystemdBinding | undefined {
  if (!pid.test(service.MainPID) || Number(service.MainPID) !== daemon.process.pid || !invocationId.test(service.InvocationID) || !invocationId.test(socket.InvocationID)
    || service.ActiveState !== 'active' || service.SubState !== 'running' || socket.ActiveState !== 'active' || socket.SubState !== 'running'
    || !includesUnit(service.TriggeredBy, 'docker.socket') || !includesUnit(socket.Triggers, 'docker.service') || socket.Listen !== `${daemon.socketPath} (Stream)`
    || !/\bpath=\/usr\/bin\/dockerd\b/.test(service.ExecStart) || !/\bargv\[\]=.*\bdockerd -H fd:\/\//.test(service.ExecStart)) return undefined
  return { kind: 'systemd', serviceInvocationId: service.InvocationID, socketInvocationId: socket.InvocationID }
}

function sameProcess(left: { bootId: string; pid: number; startTicks: string } | undefined, daemon: DaemonWitness): boolean {
  return !!left && left.bootId === daemon.process.bootId && left.pid === daemon.process.pid && left.startTicks === daemon.process.startTicks
}

async function dockerdFdCommand(pid: number): Promise<boolean> {
  try {
    const arguments_ = (await readFile(`/proc/${pid}/cmdline`)).toString('utf8').split('\0').filter(Boolean)
    return basename(arguments_[0] ?? '') === 'dockerd' && arguments_.some((value, index) => value === '-H' && arguments_[index + 1] === 'fd://')
  } catch { return false }
}

/**
 * Attests the systemd configuration chain, not a kernel-level ownership proof
 * for a particular inherited file descriptor. Every missing or changing datum
 * is rejected so callers retain uncertainty rather than freeing work.
 */
export async function captureSystemdBinding(daemon: DaemonWitness): Promise<SystemdBinding | undefined> {
  if (!daemon || typeof daemon !== 'object' || daemon.socketPath !== '/run/docker.sock') return undefined
  if (!sameProcess(await processWitness(daemon.process.pid), daemon)) return undefined
  const [firstService, firstSocket] = await Promise.all([show('docker.service'), show('docker.socket')])
  if (!firstService || !firstSocket || !matches(daemon, firstService, firstSocket) || !await dockerdFdCommand(daemon.process.pid)) return undefined
  if (!sameProcess(await processWitness(daemon.process.pid), daemon)) return undefined
  const [secondService, secondSocket] = await Promise.all([show('docker.service'), show('docker.socket')])
  if (!secondService || !secondSocket || !equalUnit(firstService, secondService) || !equalUnit(firstSocket, secondSocket)) return undefined
  if (!sameProcess(await processWitness(daemon.process.pid), daemon) || !await dockerdFdCommand(daemon.process.pid)) return undefined
  return matches(daemon, secondService, secondSocket)
}
