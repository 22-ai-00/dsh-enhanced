import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LINUX_SO_PEERCRED, LINUX_SOL_SOCKET, LINUX_UCRED_SIZE, createLinuxPeerCredentialInspector, inspectLinuxPeerCredentials,
} from '../src/broker-peer-linux.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function connectedUnixPair(): Promise<{ serverSocket: Socket; clientSocket: Socket; close: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-peercred-'))
  roots.push(root)
  const path = join(root, 'broker.sock')
  const server = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(path, resolveListen)
  })
  const accepted = new Promise<Socket>(resolveAccept => server.once('connection', resolveAccept))
  const clientSocket = createConnection({ path })
  const serverSocket = await accepted
  const close = async (): Promise<void> => {
    serverSocket.destroy()
    clientSocket.destroy()
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
  }
  return { serverSocket, clientSocket, close }
}

describe('inspectLinuxPeerCredentials', () => {
  it.runIf(process.platform === 'linux')('reads pid, uid and gid from a real kernel SO_PEERCRED UDS query', async () => {
    const pair = await connectedUnixPair()
    try {
      const credentials = inspectLinuxPeerCredentials(pair.serverSocket, new AbortController().signal)
      expect(credentials).toEqual({ pid: process.pid, uid: process.getuid?.(), gid: process.getgid?.() })
    } finally { await pair.close() }
  })

  it.runIf(process.platform === 'linux')('passes the accepted socket fd to getsockopt with Linux SO_PEERCRED constants', async () => {
    const pair = await connectedUnixPair()
    try {
      let observed: { fd: number; level: number; option: number; length: number } | undefined
      const inspector = createLinuxPeerCredentialInspector(() => ({
        errno: () => 0,
        getsockopt: (fd, level, option, value, length) => {
          observed = { fd, level, option, length: length[0] ?? 0 }
          value.pid = process.pid
          value.uid = process.getuid?.() ?? 0
          value.gid = process.getgid?.() ?? 0
          return 0
        },
      }))
      expect(inspector(pair.serverSocket, new AbortController().signal)).toEqual({ pid: process.pid, uid: process.getuid?.(), gid: process.getgid?.() })
      expect(observed).toMatchObject({ level: LINUX_SOL_SOCKET, option: LINUX_SO_PEERCRED, length: LINUX_UCRED_SIZE })
      expect(observed?.fd).toBeGreaterThanOrEqual(0)
    } finally { await pair.close() }
  })

  it('fails closed when the socket fd is unavailable', () => {
    const inspector = createLinuxPeerCredentialInspector(() => {
      throw new Error('native binding must not be loaded without an fd')
    })
    expect(inspector({} as Socket, new AbortController().signal)).toBeUndefined()
  })

  it('fails closed before native loading on non-Linux platforms', () => {
    const inspector = createLinuxPeerCredentialInspector(() => {
      throw new Error('native binding must not be loaded outside Linux')
    }, 'darwin')
    expect(inspector({} as Socket, new AbortController().signal)).toBeUndefined()
  })

  it.runIf(process.platform === 'linux')('fails closed when the native ABI call fails or returns an invalid shape', async () => {
    const pair = await connectedUnixPair()
    try {
      const failing = createLinuxPeerCredentialInspector(() => ({
        getsockopt: () => -1,
      }))
      expect(failing(pair.serverSocket, new AbortController().signal)).toBeUndefined()

      const shortRead = createLinuxPeerCredentialInspector(() => ({
        getsockopt: (_fd, _level, _option, value, length) => {
          value.pid = process.pid
          value.uid = process.getuid?.() ?? 0
          value.gid = process.getgid?.() ?? 0
          length[0] = LINUX_UCRED_SIZE - 1
          return 0
        },
      }))
      expect(shortRead(pair.serverSocket, new AbortController().signal)).toBeUndefined()
    } finally { await pair.close() }
  })
})
