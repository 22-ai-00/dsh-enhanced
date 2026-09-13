import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'

const fsControl = vi.hoisted(() => ({ failure: '', code: 'EACCES' }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: (...args: any[]) => {
      if (fsControl.failure !== '' && args[0] === fsControl.failure) throw Object.assign(new Error('fixture denied'), { code: fsControl.code })
      return actual.readFileSync(...args as [any])
    },
  }
})

const promiseControl = vi.hoisted(() => ({ mode: '', executable: '', opens: 0, socketReads: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const boot = '00000000-0000-0000-0000-000000000000'
  const processStat = `4242 (dockerd) S ${Array.from({ length: 18 }, () => '0').join(' ')} 10\n`
  const fileStat = (ino: number) => ({ isFile: () => true, nlink: 1, mode: 0o100600, uid: process.getuid!(), size: 5, dev: 1, ino, mtimeMs: 1, ctimeMs: 1 })
  return {
    ...actual,
    realpath: async (path: string) => promiseControl.mode === '' ? await actual.realpath(path) : path,
    lstat: async (path: string) => {
      if (promiseControl.mode === '' || path !== '/trusted/socket') return await actual.lstat(path)
      promiseControl.socketReads++
      return { isSocket: () => true, dev: 2, ino: promiseControl.mode === 'socket-swap' && promiseControl.socketReads > 1 ? 3 : 2 }
    },
    stat: async (path: string) => {
      if (promiseControl.mode === '') return await actual.stat(path)
      if (path === promiseControl.executable) return { isFile: () => true, mode: 0o100700 }
      if (path === '/proc/4242') return { uid: process.getuid!() }
      return await actual.stat(path)
    },
    readFile: async (path: string, ...args: any[]) => {
      if (promiseControl.mode === '') return await actual.readFile(path, ...args as [any])
      if (path === '/proc/sys/kernel/random/boot_id') return boot
      if (path === '/proc/4242/stat') return processStat
      return await actual.readFile(path, ...args as [any])
    },
    open: async (path: string, ...args: any[]) => {
      if (promiseControl.mode === '' || path !== '/trusted/pid') return await actual.open(path, ...args as [any])
      const opening = ++promiseControl.opens
      return {
        stat: async () => fileStat(1),
        read: async (buffer: Buffer) => { const value = promiseControl.mode === 'pid-swap' && opening > 1 ? '4243\n' : '4242\n'; buffer.write(value); return { bytesRead: value.length, buffer } },
        close: async () => undefined,
      }
    },
  }
})

import { captureDaemonWitness, processExited, processWitness, validateCreationWitness } from '../src/runtime-witness.ts'

describe('runtime witnesses', () => {
  it.runIf(process.platform === 'linux')('identifies the current process and proves a reaped child exited', async () => {
    const current = await processWitness()
    expect(current).toBeDefined()
    expect(processExited(current!)).toBe(false)

    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      if (child.pid === undefined) throw new Error('child did not start')
      const witness = await processWitness(child.pid)
      expect(witness).toMatchObject({ pid: child.pid })
      expect(processExited(witness!)).toBe(false)
      child.kill('SIGKILL')
      await once(child, 'exit')
      expect(processExited(witness!)).toBe(true)
    } finally {
      if (!child.killed) child.kill('SIGKILL')
    }
  })

  it('rejects malformed caller-controlled witness objects', () => {
    expect(() => validateCreationWitness(undefined)).toThrow('invalid creation witness')
    expect(() => validateCreationWitness({ daemon: {}, supervisor: {} })).toThrow('invalid creation witness')
    expect(() => validateCreationWitness({
      daemon: { process: { bootId: 'bad', pid: 0, startTicks: '0' }, engineId: 'bad value', dockerPath: 'docker', socketPath: '/socket', pidFile: '/pid' },
      supervisor: { bootId: 'bad', pid: 0, startTicks: '0' },
    })).toThrow('invalid creation witness')
  })

  it.runIf(process.platform === 'linux')('fails closed on unreadable boot metadata and detects a replaced process identity', async () => {
    const witness = await processWitness()
    expect(witness).toBeDefined()
    fsControl.failure = '/proc/sys/kernel/random/boot_id'
    try { expect(processExited(witness!)).toBe(false) } finally { fsControl.failure = '' }
    fsControl.failure = `/proc/${witness!.pid}/stat`
    try { expect(processExited(witness!)).toBe(false) } finally { fsControl.failure = '' }
    const replacement = { ...witness!, startTicks: witness!.startTicks === '1' ? '2' : '1' }
    expect(processExited(replacement)).toBe(true)
  })

  it.runIf(process.platform === 'linux')('does not treat a missing boot id as an exit, but recognizes another boot', async () => {
    const witness = await processWitness()
    expect(witness).toBeDefined()
    fsControl.failure = '/proc/sys/kernel/random/boot_id'
    try { expect(processExited(witness!)).toBe(false) } finally { fsControl.failure = '' }
    fsControl.code = 'ENOENT'
    fsControl.failure = '/proc/sys/kernel/random/boot_id'
    try { expect(processExited(witness!)).toBe(false) } finally { fsControl.failure = ''; fsControl.code = 'EACCES' }
    const anotherBoot = { ...witness!, bootId: witness!.bootId === '00000000-0000-0000-0000-000000000000' ? '11111111-1111-1111-1111-111111111111' : '00000000-0000-0000-0000-000000000000' }
    expect(processExited(anotherBoot)).toBe(true)
  })

  it('accepts creation witnesses from one boot only', () => {
    const process = { bootId: '00000000-0000-0000-0000-000000000000', pid: 1, startTicks: '1' }
    const value = { daemon: { process, engineId: 'engine:1', dockerPath: '/usr/bin/docker', socketPath: '/run/docker.sock', pidFile: '/run/docker.pid' }, supervisor: { ...process, pid: 2 } }
    expect(validateCreationWitness(value)).toEqual(value)
    expect(() => validateCreationWitness({ ...value, supervisor: { ...value.supervisor, bootId: '11111111-1111-1111-1111-111111111111' } })).toThrow('boot generations')
  })

  it.each(['stable', 'pid-swap', 'socket-swap'] as const)('checks %s metadata after Docker info', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'witness-docker-'))
    const executable = join(root, 'docker-info')
    await writeFile(executable, '#!/bin/sh\nprintf engine:1\n', { mode: 0o700 }); await chmod(executable, 0o700)
    promiseControl.mode = mode; promiseControl.executable = executable; promiseControl.opens = 0; promiseControl.socketReads = 0
    try {
      const witness = await captureDaemonWitness({ dockerPath: executable, socketPath: '/trusted/socket', pidFile: '/trusted/pid' })
      if (mode === 'stable') expect(witness).toMatchObject({ engineId: 'engine:1', process: { pid: 4242, startTicks: '10' } })
      else expect(witness).toBeUndefined()
      expect(promiseControl.opens).toBe(2)
      expect(promiseControl.socketReads).toBe(2)
    }
    finally { promiseControl.mode = ''; promiseControl.executable = ''; await rm(root, { recursive: true, force: true }) }
  })
})
