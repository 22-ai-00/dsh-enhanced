import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

const control = vi.hoisted(() => ({ responses: [] as Array<{ code: number; output: string } | undefined> }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill(): boolean }
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
      const response = control.responses.shift()
      if (response !== undefined) queueMicrotask(() => { child.stdout.end(response.output); child.stderr.end(); child.emit('close', response.code) })
      return child as unknown as ReturnType<typeof actual.spawn>
    },
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: async (path: string, ...args: any[]) => path === `/proc/${process.pid}/cmdline` ? Buffer.from('/usr/bin/dockerd\0-H\0fd://\0') : await actual.readFile(path, ...args as [any]) }
})

import { captureSystemdBinding } from '../src/daemon-binding.ts'
import { processWitness } from '../src/runtime-witness.ts'

const id = '0123456789abcdef0123456789abcdef'
function unit(kind: 'service' | 'socket', invocation = id): string {
  const values = [
    `MainPID=${kind === 'service' ? process.pid : 0}`,
    `InvocationID=${invocation}`,
    'ActiveState=active', 'SubState=running',
    `TriggeredBy=${kind === 'service' ? 'docker.socket' : ''}`,
    `Triggers=${kind === 'socket' ? 'docker.service' : ''}`,
    `Listen=${kind === 'socket' ? '/run/docker.sock (Stream)' : ''}`,
    `ExecStart=${kind === 'service' ? '{ path=/usr/bin/dockerd ; argv[]=/usr/bin/dockerd -H fd:// ; }' : ''}`,
  ]
  const allowed = kind === 'service' ? new Set(['MainPID', 'InvocationID', 'ActiveState', 'SubState', 'TriggeredBy', 'Triggers', 'ExecStart']) : new Set(['InvocationID', 'ActiveState', 'SubState', 'TriggeredBy', 'Triggers', 'Listen'])
  return values.filter(value => allowed.has(value.slice(0, value.indexOf('=')))).join('\n') + '\n'
}

async function daemon() {
  const process = await processWitness()
  if (!process) throw new Error('current process witness unavailable')
  return { process, engineId: 'engine:1', dockerPath: '/usr/bin/docker', socketPath: '/run/docker.sock', pidFile: '/run/docker.pid' }
}

describe('systemd Docker binding', () => {
  it('accepts two identical systemd socket-activation samples', async () => {
    control.responses = [{ code: 0, output: unit('service') }, { code: 0, output: unit('socket') }, { code: 0, output: unit('service') }, { code: 0, output: unit('socket') }]
    await expect(captureSystemdBinding(await daemon())).resolves.toEqual({ kind: 'systemd', serviceInvocationId: id, socketInvocationId: id })
  })

  it('rejects a service generation change and malformed manager output', async () => {
    control.responses = [{ code: 0, output: unit('service') }, { code: 0, output: unit('socket') }, { code: 0, output: unit('service', '11111111111111111111111111111111') }, { code: 0, output: unit('socket') }]
    await expect(captureSystemdBinding(await daemon())).resolves.toBeUndefined()
    control.responses = [{ code: 0, output: 'MainPID=1\n' }, { code: 0, output: unit('socket') }]
    await expect(captureSystemdBinding(await daemon())).resolves.toBeUndefined()
  })

  it('rejects a manager timeout without accepting partial output', async () => {
    control.responses = [undefined, { code: 0, output: unit('socket') }]
    const pending = captureSystemdBinding(await daemon())
    await expect(pending).resolves.toBeUndefined()
  }, 15_000)

  it('rejects stdout above the 16 KiB manager-output limit', async () => {
    control.responses = [{ code: 0, output: `${unit('service')}${'x'.repeat(16_384)}` }, { code: 0, output: unit('socket') }]
    await expect(captureSystemdBinding(await daemon())).resolves.toBeUndefined()
  })
})
