import type { Socket } from 'node:net'
import { createRequire } from 'node:module'
import type koffiModule from 'koffi'
import type { BrokerPeerCredentials, BrokerPeerCredentialInspector } from './broker-server.js'

interface SocketWithHandle {
  readonly _handle?: { readonly fd?: unknown } | null
}

export interface MacosNativePeercredBinding {
  readonly getsockopt: (fd: number, level: number, option: number, value: Buffer, length: number[]) => number
}

export const MACOS_SOL_LOCAL = 0
export const MACOS_LOCAL_PEERCRED = 1
export const MACOS_LOCAL_PEERPID = 2
export const MACOS_XUCRED_SIZE = 76
export const MACOS_XUCRED_VERSION = 0
export const MACOS_MAX_GROUPS = 16
const MAX_KERNEL_ID = 0x7fffffff

let binding: MacosNativePeercredBinding | undefined
let bindingFailed = false
const require = createRequire(import.meta.url)

function validKernelId(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= MAX_KERNEL_ID
}

function socketFd(socket: Socket): number | undefined {
  const fd = (socket as SocketWithHandle)._handle?.fd
  return validKernelId(fd, 0) ? fd : undefined
}

function loadBinding(): MacosNativePeercredBinding | undefined {
  if (binding || bindingFailed) return binding
  try {
    const koffi = require('koffi') as typeof koffiModule
    const libSystem = koffi.load('libSystem.B.dylib')
    binding = {
      getsockopt: libSystem.func('getsockopt', 'int', ['int', 'int', 'int', koffi.out(koffi.pointer('uint8')), koffi.inout(koffi.pointer('uint'))]) as MacosNativePeercredBinding['getsockopt'],
    }
  } catch {
    bindingFailed = true
  }
  return binding
}

/**
 * Parse raw macOS `struct xucred` (76 bytes):
 *   u_int cr_version (offset 0, 4 bytes)
 *   uid_t cr_uid     (offset 4, 4 bytes)
 *   short cr_ngroups (offset 8, 2 bytes) + 2 bytes padding (offset 10..11)
 *   gid_t cr_groups[16] (offset 12..75, 16 * 4 bytes)
 */
export function parseMacosXucredBuffer(buffer: Buffer): { version: number; uid: number; ngroups: number; gid: number } | undefined {
  if (!Buffer.isBuffer(buffer) || buffer.length < MACOS_XUCRED_SIZE) return undefined
  const version = buffer.readUInt32LE(0)
  const uid = buffer.readUInt32LE(4)
  const ngroups = buffer.readInt16LE(8)
  const gid = buffer.readUInt32LE(12)
  if (version !== MACOS_XUCRED_VERSION) return undefined
  if (!validKernelId(uid, 0)) return undefined
  if (!Number.isSafeInteger(ngroups) || ngroups < 1 || ngroups > MACOS_MAX_GROUPS) return undefined
  if (!validKernelId(gid, 0)) return undefined
  return { version, uid, ngroups, gid }
}

export function createMacosPeerCredentialInspector(
  loadNative: () => MacosNativePeercredBinding | undefined = loadBinding,
  platform: NodeJS.Platform = process.platform,
): BrokerPeerCredentialInspector {
  return (socket: Socket): BrokerPeerCredentials | undefined => {
    if (platform !== 'darwin') return undefined
    const fd = socketFd(socket)
    if (fd === undefined) return undefined
    const native = loadNative()
    if (!native) return undefined

    const xucredBuf = Buffer.alloc(MACOS_XUCRED_SIZE)
    const xucredLen = [MACOS_XUCRED_SIZE]
    let rc: number
    try {
      rc = native.getsockopt(fd, MACOS_SOL_LOCAL, MACOS_LOCAL_PEERCRED, xucredBuf, xucredLen)
    } catch {
      return undefined
    }
    if (rc !== 0 || xucredLen[0] !== MACOS_XUCRED_SIZE) return undefined
    const parsed = parseMacosXucredBuffer(xucredBuf)
    if (!parsed) return undefined

    const pidBuf = Buffer.alloc(4)
    const pidLen = [4]
    let pidRc: number
    try {
      pidRc = native.getsockopt(fd, MACOS_SOL_LOCAL, MACOS_LOCAL_PEERPID, pidBuf, pidLen)
    } catch {
      return { uid: parsed.uid, gid: parsed.gid }
    }
    if (pidRc === 0 && pidLen[0] === 4) {
      const pid = pidBuf.readInt32LE(0)
      if (!validKernelId(pid, 1)) return undefined
      return { uid: parsed.uid, gid: parsed.gid, pid }
    }
    return { uid: parsed.uid, gid: parsed.gid }
  }
}

export const inspectMacosPeerCredentials: BrokerPeerCredentialInspector = createMacosPeerCredentialInspector()

export function macosPeerCredentialsAvailable(): boolean {
  return process.platform === 'darwin' && !!loadBinding()
}
