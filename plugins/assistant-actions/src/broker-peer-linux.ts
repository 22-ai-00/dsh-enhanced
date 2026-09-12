import type { Socket } from 'node:net'
import { createRequire } from 'node:module'
import type koffiModule from 'koffi'
import type { BrokerPeerCredentials, BrokerPeerCredentialInspector } from './broker-server.js'

interface SocketWithHandle {
  readonly _handle?: { readonly fd?: unknown } | null
}

interface NativePeerCredentials {
  pid?: unknown
  uid?: unknown
  gid?: unknown
}

interface NativePeercredBinding {
  readonly getsockopt: (fd: number, level: number, option: number, value: NativePeerCredentials, length: number[]) => number
}

export const LINUX_SOL_SOCKET = 1
export const LINUX_SO_PEERCRED = 17
export const LINUX_UCRED_SIZE = 12
const MAX_KERNEL_ID = 0x7fffffff

let binding: NativePeercredBinding | undefined
let bindingFailed = false
const require = createRequire(import.meta.url)

function validKernelId(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= MAX_KERNEL_ID
}

function socketFd(socket: Socket): number | undefined {
  const fd = (socket as SocketWithHandle)._handle?.fd
  return validKernelId(fd, 0) ? fd : undefined
}

function loadBinding(): NativePeercredBinding | undefined {
  if (binding || bindingFailed) return binding
  try {
    const koffi = require('koffi') as typeof koffiModule
    const ucred = koffi.struct('dsh_assistant_actions_linux_ucred', { pid: 'int', uid: 'uint', gid: 'uint' })
    const libc = koffi.load('libc.so.6')
    binding = {
      getsockopt: libc.func('getsockopt', 'int', ['int', 'int', 'int', koffi.out(koffi.pointer(ucred)), koffi.inout(koffi.pointer('uint'))]) as NativePeercredBinding['getsockopt'],
    }
  } catch {
    bindingFailed = true
  }
  return binding
}

export function createLinuxPeerCredentialInspector(loadNative: () => NativePeercredBinding | undefined = loadBinding, platform: NodeJS.Platform = process.platform): BrokerPeerCredentialInspector {
  return (socket: Socket): BrokerPeerCredentials | undefined => {
    if (platform !== 'linux') return undefined
    const fd = socketFd(socket)
    if (fd === undefined) return undefined
    const native = loadNative()
    if (!native) return undefined

    const credential: NativePeerCredentials = {}
    const length = [LINUX_UCRED_SIZE]
    let rc: number
    try { rc = native.getsockopt(fd, LINUX_SOL_SOCKET, LINUX_SO_PEERCRED, credential, length) } catch { return undefined }
    if (rc !== 0 || length[0] !== LINUX_UCRED_SIZE) return undefined
    if (!validKernelId(credential.pid, 1) || !validKernelId(credential.uid, 0) || !validKernelId(credential.gid, 0)) return undefined
    return { pid: credential.pid, uid: credential.uid, gid: credential.gid }
  }
}

/**
 * Linux kernel peer credential inspector for accepted Unix-domain sockets.
 *
 * Returns undefined on every unsupported or ambiguous path so callers fail
 * closed instead of trusting process-level or fixture-provided identities.
 */
export const inspectLinuxPeerCredentials: BrokerPeerCredentialInspector = createLinuxPeerCredentialInspector()

export function linuxPeerCredentialsAvailable(): boolean {
  return process.platform === 'linux' && !!loadBinding()
}
