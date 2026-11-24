import { lstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, normalize, resolve } from 'node:path'
import type koffiModule from 'koffi'
import type { Socket } from 'node:net'
import type { BrokerPeerCredentials, BrokerPeerCredentialInspector } from './broker-server.js'

export const WINDOWS_PIPE_PATH_PATTERN = /^\\\\\.\\pipe\\[A-Za-z0-9._:-]{1,200}$/u
export const WINDOWS_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
export const WINDOWS_TOKEN_QUERY = 0x0008
export const WINDOWS_TOKEN_USER = 1
export const WINDOWS_OWNER_SECURITY_INFORMATION = 0x00000001
export const WINDOWS_DACL_SECURITY_INFORMATION = 0x00000004
export const WINDOWS_SE_DACL_PROTECTED = 0x1000
export const WINDOWS_ACL_SIZE_INFORMATION = 2
export const WINDOWS_ACCESS_ALLOWED_ACE_TYPE = 0
export const WINDOWS_ACCESS_DENIED_ACE_TYPE = 1
export const WINDOWS_ACCESS_DENIED_OBJECT_ACE_TYPE = 6
export const WINDOWS_ACCESS_DENIED_CALLBACK_ACE_TYPE = 10
export const WINDOWS_ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE = 12

export interface WindowsNativePeerBinding {
  readonly getNamedPipePeerProcessId: (socket: Socket, role: 'client' | 'server') => number | undefined
  readonly getProcessUserSid: (pid: number) => string | undefined
}

export interface WindowsRawNativeApi {
  readonly getNamedPipeClientProcessId: (handle: unknown, pidOut: number[]) => number
  readonly getNamedPipeServerProcessId: (handle: unknown, pidOut: number[]) => number
  readonly openProcess: (desiredAccess: number, inheritHandle: boolean, pid: number) => unknown
  readonly openProcessToken: (processHandle: unknown, desiredAccess: number, tokenHandleOut: unknown[]) => number
  readonly getTokenInformation: (tokenHandle: unknown, tokenInfoClass: number, infoOut: Buffer | null, length: number, returnLengthOut: number[]) => number
  readonly extractTokenUserSidPointer: (tokenUserBuffer: Buffer) => unknown
  readonly convertSidToStringSidW: (sidPointer: unknown, stringSidOut: unknown[]) => number
  readonly readWideStringAndFree: (stringPtr: unknown) => string | undefined
  readonly closeHandle: (handle: unknown) => number
}

export interface WindowsRawAclApi {
  readonly getFileSecurityW: (
    path: string,
    requestedInfo: number,
    securityDescriptor: Buffer | null,
    length: number,
    lengthNeededOut: number[],
  ) => number
  readonly getSecurityDescriptorControl: (
    securityDescriptor: Buffer,
    controlOut: number[],
    revisionOut: number[],
  ) => number
  readonly getSecurityDescriptorOwner: (
    securityDescriptor: Buffer,
    ownerSidOut: unknown[],
    ownerDefaultedOut: number[],
  ) => number
  readonly getSecurityDescriptorDacl: (
    securityDescriptor: Buffer,
    daclPresentOut: number[],
    daclOut: unknown[],
    daclDefaultedOut: number[],
  ) => number
  readonly getAclInformation: (
    dacl: unknown,
    aclInfoOut: Buffer,
    aclInfoLength: number,
    aclInfoClass: number,
  ) => number
  readonly getAce: (
    dacl: unknown,
    aceIndex: number,
    aceOut: unknown[],
  ) => number
  readonly readAceBytes: (acePtr: unknown) => Buffer | undefined
  readonly convertSidToStringSidW: (sidPointer: unknown, stringSidOut: unknown[]) => number
  readonly readWideStringAndFree: (stringPtr: unknown) => string | undefined
}

interface SocketWithWindowsHandle {
  readonly _handle?: { readonly fd?: unknown; readonly handle?: unknown } | null
}

let binding: WindowsNativePeerBinding | undefined
let bindingFailed = false
let aclInspector: ((path: string) => WindowsAclInspection | undefined) | undefined
let aclInspectorFailed = false
const require = createRequire(import.meta.url)

function validPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 0x7fffffff
}

function validSid(value: unknown): value is string {
  return typeof value === 'string' && /^S-1-(?:\d+-)*\d+$/u.test(value) && value.length <= 256
}

export function isWindowsNamedPipePath(value: unknown): value is string {
  return typeof value === 'string' && WINDOWS_PIPE_PATH_PATTERN.test(value)
}

export function normalizeWindowsPipePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('..')) {
    throw new Error('assistant-actions: invalid Windows named pipe path')
  }
  if (isWindowsNamedPipePath(value)) return value
  if (/^[A-Za-z0-9._:-]{1,200}$/u.test(value)) return `\\\\.\\pipe\\${value}`
  throw new Error('assistant-actions: invalid Windows named pipe path')
}

function socketWindowsHandle(socket: Socket): unknown {
  const internal = (socket as SocketWithWindowsHandle)._handle
  if (!internal) return undefined
  if (internal.handle !== undefined && internal.handle !== null) return internal.handle
  if (typeof internal.fd === 'number' && Number.isSafeInteger(internal.fd) && internal.fd >= 0) return internal.fd
  return undefined
}

export function createWindowsBindingFromRawApi(api: WindowsRawNativeApi): WindowsNativePeerBinding {
  return {
    getNamedPipePeerProcessId(socket, role) {
      const handle = socketWindowsHandle(socket)
      if (handle === undefined) return undefined
      const pidOut = [0]
      const ok = role === 'client'
        ? api.getNamedPipeClientProcessId(handle, pidOut)
        : api.getNamedPipeServerProcessId(handle, pidOut)
      if (!ok || !validPid(pidOut[0])) return undefined
      return pidOut[0]
    },
    getProcessUserSid(pid) {
      if (!validPid(pid)) return undefined
      let processHandle: unknown
      let tokenHandle: unknown
      try {
        processHandle = api.openProcess(WINDOWS_PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
        if (!processHandle) return undefined
        const tokenOut: unknown[] = [null]
        if (!api.openProcessToken(processHandle, WINDOWS_TOKEN_QUERY, tokenOut) || !tokenOut[0]) return undefined
        tokenHandle = tokenOut[0]
        const lenOut = [0]
        api.getTokenInformation(tokenHandle, WINDOWS_TOKEN_USER, null, 0, lenOut)
        const needed = lenOut[0] ?? 0
        if (!Number.isSafeInteger(needed) || needed < 8 || needed > 4096) return undefined
        const buffer = Buffer.alloc(needed)
        if (!api.getTokenInformation(tokenHandle, WINDOWS_TOKEN_USER, buffer, needed, lenOut)) return undefined
        const sidPtr = api.extractTokenUserSidPointer(buffer)
        if (!sidPtr) return undefined
        const sidOut: unknown[] = [null]
        if (!api.convertSidToStringSidW(sidPtr, sidOut) || !sidOut[0]) return undefined
        const sid = api.readWideStringAndFree(sidOut[0])
        return validSid(sid) ? sid : undefined
      } catch {
        return undefined
      } finally {
        if (tokenHandle) try { api.closeHandle(tokenHandle) } catch { /* ignore */ }
        if (processHandle) try { api.closeHandle(processHandle) } catch { /* ignore */ }
      }
    },
  }
}

function loadBinding(): WindowsNativePeerBinding | undefined {
  if (binding || bindingFailed) return binding
  if (process.platform !== 'win32') return undefined
  try {
    const koffi = require('koffi') as typeof koffiModule
    const kernel32 = koffi.load('kernel32.dll')
    const advapi32 = koffi.load('advapi32.dll')
    const handleType = koffi.pointer('void')
    const GetNamedPipeClientProcessId = kernel32.func('GetNamedPipeClientProcessId', 'int', [handleType, koffi.out(koffi.pointer('uint32'))])
    const GetNamedPipeServerProcessId = kernel32.func('GetNamedPipeServerProcessId', 'int', [handleType, koffi.out(koffi.pointer('uint32'))])
    const OpenProcess = kernel32.func('OpenProcess', handleType, ['uint32', 'int', 'uint32'])
    const CloseHandle = kernel32.func('CloseHandle', 'int', [handleType])
    const LocalFree = kernel32.func('LocalFree', handleType, [handleType])
    const OpenProcessToken = advapi32.func('OpenProcessToken', 'int', [handleType, 'uint32', koffi.out(koffi.pointer(handleType))])
    const GetTokenInformation = advapi32.func('GetTokenInformation', 'int', [handleType, 'uint32', 'void*', 'uint32', koffi.out(koffi.pointer('uint32'))])
    const ConvertSidToStringSidW = advapi32.func('ConvertSidToStringSidW', 'int', [handleType, koffi.out(koffi.pointer(koffi.pointer('uint16')))])

    const rawApi: WindowsRawNativeApi = {
      getNamedPipeClientProcessId: (h, pidOut) => GetNamedPipeClientProcessId(h, pidOut) as number,
      getNamedPipeServerProcessId: (h, pidOut) => GetNamedPipeServerProcessId(h, pidOut) as number,
      openProcess: (access, inherit, pid) => OpenProcess(access, inherit ? 1 : 0, pid),
      openProcessToken: (hProc, access, tokOut) => OpenProcessToken(hProc, access, tokOut) as number,
      getTokenInformation: (hTok, cls, buf, len, retLen) => GetTokenInformation(hTok, cls, buf, len, retLen) as number,
      extractTokenUserSidPointer: buf => {
        // TOKEN_USER starts with SID_AND_ATTRIBUTES { PSID Sid; DWORD Attributes; }
        const decoded = koffi.decode(buf, 'void*')
        return decoded
      },
      convertSidToStringSidW: (sidPtr, out) => ConvertSidToStringSidW(sidPtr, out) as number,
      readWideStringAndFree: ptr => {
        try {
          if (!ptr) return undefined
          return koffi.decode(ptr, 'str16') as string
        } finally {
          if (ptr) try { LocalFree(ptr) } catch { /* ignore */ }
        }
      },
      closeHandle: h => CloseHandle(h) as number,
    }
    binding = createWindowsBindingFromRawApi(rawApi)
  } catch {
    bindingFailed = true
  }
  return binding
}

export function createWindowsPeerInspector(
  loadNative: () => WindowsNativePeerBinding | undefined = loadBinding,
  platform: NodeJS.Platform = process.platform,
  role: 'client' | 'server' = 'client',
): BrokerPeerCredentialInspector {
  return (socket: Socket): BrokerPeerCredentials | undefined => {
    if (platform !== 'win32') return undefined
    const native = loadNative()
    if (!native) return undefined
    try {
      const pid = native.getNamedPipePeerProcessId(socket, role)
      if (!validPid(pid)) return undefined
      const sid = native.getProcessUserSid(pid)
      if (!validSid(sid)) return undefined
      return { uid: 0, gid: 0, pid, sid }
    } catch {
      return undefined
    }
  }
}

export const inspectWindowsPeerCredentials: BrokerPeerCredentialInspector = createWindowsPeerInspector()
export const inspectWindowsServerPeerCredentials: BrokerPeerCredentialInspector = createWindowsPeerInspector(loadBinding, process.platform, 'server')

export function windowsPeerCredentialsAvailable(): boolean {
  return process.platform === 'win32' && !!loadBinding()
}

export interface WindowsAclInspection {
  readonly ownerSid: string
  readonly protectedDacl: boolean
  readonly allowsNonOwner: boolean
}

function sidPointerToString(
  api: Pick<WindowsRawAclApi, 'convertSidToStringSidW' | 'readWideStringAndFree'>,
  sidPtr: unknown,
): string | undefined {
  if (!sidPtr) return undefined
  const out: unknown[] = [null]
  if (!api.convertSidToStringSidW(sidPtr, out) || !out[0]) return undefined
  const sid = api.readWideStringAndFree(out[0])
  return validSid(sid) ? sid : undefined
}

export function createWindowsAclInspectorFromRawApi(
  api: WindowsRawAclApi,
): (targetPath: string) => WindowsAclInspection | undefined {
  return (targetPath: string): WindowsAclInspection | undefined => {
    try {
      const requestedInfo = WINDOWS_OWNER_SECURITY_INFORMATION | WINDOWS_DACL_SECURITY_INFORMATION
      const neededOut = [0]
      api.getFileSecurityW(targetPath, requestedInfo, null, 0, neededOut)
      const needed = neededOut[0] ?? 0
      if (!Number.isSafeInteger(needed) || needed < 20 || needed > 1_048_576) return undefined
      const sd = Buffer.alloc(needed)
      if (!api.getFileSecurityW(targetPath, requestedInfo, sd, needed, neededOut)) return undefined

      const controlOut = [0]
      const revisionOut = [0]
      if (!api.getSecurityDescriptorControl(sd, controlOut, revisionOut)) return undefined
      const protectedDacl = ((controlOut[0] ?? 0) & WINDOWS_SE_DACL_PROTECTED) !== 0

      const ownerOut: unknown[] = [null]
      const ownerDefaultedOut = [0]
      if (!api.getSecurityDescriptorOwner(sd, ownerOut, ownerDefaultedOut) || !ownerOut[0]) return undefined
      const ownerSid = sidPointerToString(api, ownerOut[0])
      if (!ownerSid) return undefined

      const daclPresentOut = [0]
      const daclOut: unknown[] = [null]
      const daclDefaultedOut = [0]
      if (!api.getSecurityDescriptorDacl(sd, daclPresentOut, daclOut, daclDefaultedOut)) return undefined
      if (!daclPresentOut[0] || !daclOut[0]) {
        return { ownerSid, protectedDacl, allowsNonOwner: true }
      }

      const aclInfoBuf = Buffer.alloc(12)
      if (!api.getAclInformation(daclOut[0], aclInfoBuf, 12, WINDOWS_ACL_SIZE_INFORMATION)) return undefined
      const aceCount = aclInfoBuf.readUInt32LE(0)
      if (!Number.isSafeInteger(aceCount) || aceCount > 4_096) return undefined

      let allowsNonOwner = false
      for (let index = 0; index < aceCount; index += 1) {
        const aceOut: unknown[] = [null]
        if (!api.getAce(daclOut[0], index, aceOut) || !aceOut[0]) return undefined
        const aceBytes = api.readAceBytes(aceOut[0])
        if (!aceBytes || aceBytes.length < 8) return undefined
        const aceType = aceBytes.readUInt8(0)
        if (
          aceType === WINDOWS_ACCESS_DENIED_ACE_TYPE
          || aceType === WINDOWS_ACCESS_DENIED_OBJECT_ACE_TYPE
          || aceType === WINDOWS_ACCESS_DENIED_CALLBACK_ACE_TYPE
          || aceType === WINDOWS_ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE
        ) {
          continue
        }
        if (aceType === WINDOWS_ACCESS_ALLOWED_ACE_TYPE) {
          if (aceBytes.length < 16) return undefined
          const mask = aceBytes.readUInt32LE(4)
          if (mask === 0) continue
          const aceSid = sidPointerToString(api, aceBytes.subarray(8))
          if (!aceSid) return undefined
          if (aceSid !== ownerSid) {
            allowsNonOwner = true
          }
          continue
        }
        // Any other ACE type (e.g., object/callback allow ACEs) fails closed.
        allowsNonOwner = true
      }

      return { ownerSid, protectedDacl, allowsNonOwner }
    } catch {
      return undefined
    }
  }
}

function loadAclInspector(): ((path: string) => WindowsAclInspection | undefined) | undefined {
  if (aclInspector || aclInspectorFailed) return aclInspector
  if (process.platform !== 'win32') return undefined
  try {
    const koffi = require('koffi') as typeof koffiModule
    const kernel32 = koffi.load('kernel32.dll')
    const advapi32 = koffi.load('advapi32.dll')
    const handleType = koffi.pointer('void')
    const LocalFree = kernel32.func('LocalFree', handleType, [handleType])
    const GetFileSecurityW = advapi32.func('GetFileSecurityW', 'int', ['str16', 'uint32', 'void*', 'uint32', koffi.out(koffi.pointer('uint32'))])
    const GetSecurityDescriptorControl = advapi32.func('GetSecurityDescriptorControl', 'int', ['void*', koffi.out(koffi.pointer('uint16')), koffi.out(koffi.pointer('uint32'))])
    const GetSecurityDescriptorOwner = advapi32.func('GetSecurityDescriptorOwner', 'int', ['void*', koffi.out(koffi.pointer(handleType)), koffi.out(koffi.pointer('int'))])
    const GetSecurityDescriptorDacl = advapi32.func('GetSecurityDescriptorDacl', 'int', ['void*', koffi.out(koffi.pointer('int')), koffi.out(koffi.pointer(handleType)), koffi.out(koffi.pointer('int'))])
    const GetAclInformation = advapi32.func('GetAclInformation', 'int', [handleType, 'void*', 'uint32', 'uint32'])
    const GetAce = advapi32.func('GetAce', 'int', [handleType, 'uint32', koffi.out(koffi.pointer(handleType))])
    const ConvertSidToStringSidW = advapi32.func('ConvertSidToStringSidW', 'int', [handleType, koffi.out(koffi.pointer(koffi.pointer('uint16')))])

    const rawApi: WindowsRawAclApi = {
      getFileSecurityW: (path, info, sd, len, neededOut) => GetFileSecurityW(path, info, sd, len, neededOut) as number,
      getSecurityDescriptorControl: (sd, controlOut, revOut) => GetSecurityDescriptorControl(sd, controlOut, revOut) as number,
      getSecurityDescriptorOwner: (sd, ownerOut, defaultedOut) => GetSecurityDescriptorOwner(sd, ownerOut, defaultedOut) as number,
      getSecurityDescriptorDacl: (sd, presentOut, daclOut, defaultedOut) => GetSecurityDescriptorDacl(sd, presentOut, daclOut, defaultedOut) as number,
      getAclInformation: (dacl, buf, len, cls) => GetAclInformation(dacl, buf, len, cls) as number,
      getAce: (dacl, idx, aceOut) => GetAce(dacl, idx, aceOut) as number,
      readAceBytes: acePtr => {
        if (!acePtr) return undefined
        const aceSize = koffi.decode(acePtr, 2, 'uint16') as number
        if (!Number.isSafeInteger(aceSize) || aceSize < 8 || aceSize > 65_535) return undefined
        return Buffer.from(koffi.view(acePtr, aceSize))
      },
      convertSidToStringSidW: (sidPtr, out) => ConvertSidToStringSidW(sidPtr, out) as number,
      readWideStringAndFree: ptr => {
        try {
          if (!ptr) return undefined
          return koffi.decode(ptr, 'str16') as string
        } finally {
          if (ptr) try { LocalFree(ptr) } catch { /* ignore */ }
        }
      },
    }
    aclInspector = createWindowsAclInspectorFromRawApi(rawApi)
  } catch {
    aclInspectorFailed = true
  }
  return aclInspector
}

export function inspectWindowsPathAcl(targetPath: string): WindowsAclInspection | undefined {
  if (process.platform !== 'win32') return undefined
  const inspector = loadAclInspector()
  return inspector ? inspector(targetPath) : undefined
}

export function verifyWindowsPrivatePath(
  targetPath: string,
  options: {
    expectedOwnerSid?: string
    checkAcl?: (path: string) => WindowsAclInspection | undefined
    allowMissing?: boolean
    platform?: NodeJS.Platform
  } = {},
): void {
  const platform = options.platform ?? process.platform
  if (!isAbsolute(targetPath) || normalize(targetPath) !== targetPath || targetPath.includes('\0') || targetPath.startsWith('\\\\')) {
    throw new Error('assistant-actions: unsafe Windows private path')
  }
  if (resolve(targetPath) !== targetPath) {
    throw new Error('assistant-actions: non-canonical Windows private path')
  }
  let missing = false
  try {
    const stat = lstatSync(targetPath, { bigint: true })
    if (stat.isSymbolicLink()) throw new Error('assistant-actions: symlink or reparse point rejected')
  } catch (error) {
    if (options.allowMissing && error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      missing = true
    } else {
      throw error
    }
  }
  if (!missing && (options.checkAcl || platform === 'win32' || options.expectedOwnerSid !== undefined)) {
    const acl = options.checkAcl ? options.checkAcl(targetPath) : inspectWindowsPathAcl(targetPath)
    if (!acl) throw new Error('assistant-actions: Windows ACL inspection unavailable')
    if (!acl.protectedDacl || acl.allowsNonOwner) throw new Error('assistant-actions: Windows private path ACL is overly permissive')
    if (options.expectedOwnerSid !== undefined && acl.ownerSid !== options.expectedOwnerSid) {
      throw new Error('assistant-actions: Windows private path owner SID mismatch')
    }
  }
}
