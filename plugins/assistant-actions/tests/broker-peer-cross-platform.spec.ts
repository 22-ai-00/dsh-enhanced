import { randomUUID } from 'node:crypto'
import { createConnection, createServer, type Socket } from 'node:net'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MACOS_LOCAL_PEERCRED,
  MACOS_LOCAL_PEERPID,
  MACOS_SOL_LOCAL,
  MACOS_XUCRED_SIZE,
  createMacosPeerCredentialInspector,
  inspectMacosPeerCredentials,
  parseMacosXucredBuffer,
} from '../src/broker-peer-macos.ts'
import {
  createWindowsAclInspectorFromRawApi,
  createWindowsBindingFromRawApi,
  createWindowsPeerInspector,
  inspectWindowsPeerCredentials,
  isWindowsNamedPipePath,
  normalizeWindowsPipePath,
  verifyWindowsPrivatePath,
} from '../src/broker-peer-windows.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function socketPair(): Promise<{ serverSocket: Socket; clientSocket: Socket; close: () => Promise<void> }> {
  let sockPath: string
  if (process.platform === 'win32') {
    sockPath = `\\\\.\\pipe\\peer-xplat-${randomUUID()}`
  } else {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'peer-xplat-')))
    roots.push(dir)
    sockPath = join(dir, 'test.sock')
  }
  let accepted: Socket | undefined
  const server = createServer(sock => { accepted = sock })
  await new Promise<void>(resolve => server.listen(sockPath, resolve))
  const clientSocket = createConnection(sockPath)
  await new Promise<void>(resolve => clientSocket.once('connect', resolve))
  await new Promise<void>(resolve => {
    const check = () => (accepted ? resolve() : setTimeout(check, 10))
    check()
  })
  return {
    serverSocket: accepted!,
    clientSocket,
    close: async () => {
      clientSocket.destroy()
      accepted?.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

describe('Cross-Platform Peer Authentication (macOS & Windows)', () => {
  it('parses macOS struct xucred (76 bytes) and LOCAL_PEERPID via injected libSystem binding', async () => {
    const pair = await socketPair()
    try {
      const inspector = createMacosPeerCredentialInspector(() => ({
        getsockopt: (_fd, level, option, value, length) => {
          if (level !== MACOS_SOL_LOCAL) return -1
          if (option === MACOS_LOCAL_PEERCRED) {
            value.writeUInt32LE(0, 0)     // cr_version = 0
            value.writeUInt32LE(501, 4)   // cr_uid = 501
            value.writeInt16LE(2, 8)      // cr_ngroups = 2
            value.writeUInt32LE(20, 12)   // cr_groups[0] = 20
            length[0] = MACOS_XUCRED_SIZE
            return 0
          }
          if (option === MACOS_LOCAL_PEERPID) {
            value.writeInt32LE(4242, 0)
            length[0] = 4
            return 0
          }
          return -1
        },
      }), 'darwin')

      expect(inspector(pair.serverSocket, new AbortController().signal)).toEqual({ uid: 501, gid: 20, pid: 4242 })
    } finally {
      await pair.close()
    }
  })

  it('fails closed for invalid macOS xucred version, ngroups, short buffer, or non-darwin platform', async () => {
    const badVersion = Buffer.alloc(MACOS_XUCRED_SIZE)
    badVersion.writeUInt32LE(1, 0)
    badVersion.writeInt16LE(1, 8)
    expect(parseMacosXucredBuffer(badVersion)).toBeUndefined()

    const badGroups = Buffer.alloc(MACOS_XUCRED_SIZE)
    badGroups.writeInt16LE(0, 8)
    expect(parseMacosXucredBuffer(badGroups)).toBeUndefined()
    expect(parseMacosXucredBuffer(Buffer.alloc(10))).toBeUndefined()

    const pair = await socketPair()
    try {
      // On Linux, default macOS inspector fails closed
      if (process.platform !== 'darwin') {
        expect(inspectMacosPeerCredentials(pair.serverSocket, new AbortController().signal)).toBeUndefined()
      }
      const shortLen = createMacosPeerCredentialInspector(() => ({
        getsockopt: (_fd, _lvl, _opt, _val, len) => { len[0] = 12; return 0 },
      }), 'darwin')
      expect(shortLen(pair.serverSocket, new AbortController().signal)).toBeUndefined()
    } finally {
      await pair.close()
    }
  })

  it.runIf(process.platform === 'darwin')('inspects real macOS LOCAL_PEERCRED on darwin', async () => {
    const pair = await socketPair()
    try {
      const creds = inspectMacosPeerCredentials(pair.serverSocket, new AbortController().signal)
      expect(creds).toMatchObject({ uid: process.getuid?.(), gid: process.getgid?.(), pid: process.pid })
    } finally {
      await pair.close()
    }
  })

  it('validates Windows Named Pipe paths and inspects PID + token SID via injected Win32 binding', async () => {
    expect(isWindowsNamedPipePath('\\\\.\\pipe\\dsh-broker-action')).toBe(true)
    expect(isWindowsNamedPipePath('\\\\remotehost\\pipe\\evil')).toBe(false)
    expect(isWindowsNamedPipePath('\\\\.\\pipe\\..\\evil')).toBe(false)
    expect(normalizeWindowsPipePath('dsh-test')).toBe('\\\\.\\pipe\\dsh-test')
    expect(() => normalizeWindowsPipePath('\\\\other\\pipe\\x')).toThrow()

    const pair = await socketPair()
    try {
      const binding = createWindowsBindingFromRawApi({
        getNamedPipeClientProcessId: (_h, pidOut) => { pidOut[0] = 8888; return 1 },
        getNamedPipeServerProcessId: (_h, pidOut) => { pidOut[0] = 9999; return 1 },
        openProcess: (_acc, _inh, pid) => (pid === 8888 ? { proc: 1 } : null),
        openProcessToken: (_hProc, _acc, tokOut) => { tokOut[0] = { tok: 1 }; return 1 },
        getTokenInformation: (_hTok, _cls, buf, _len, retLen) => {
          retLen[0] = 32
          return buf ? 1 : 0
        },
        extractTokenUserSidPointer: () => ({ sidPtr: 1 }),
        convertSidToStringSidW: (_ptr, out) => { out[0] = { strPtr: 1 }; return 1 },
        readWideStringAndFree: () => 'S-1-5-21-1000-2000-3000-1001',
        closeHandle: () => 1,
      })
      const inspector = createWindowsPeerInspector(() => binding, 'win32', 'client')
      expect(inspector(pair.serverSocket, new AbortController().signal)).toEqual({
        uid: 0,
        gid: 0,
        pid: 8888,
        sid: 'S-1-5-21-1000-2000-3000-1001',
      })

      if (process.platform !== 'win32') {
        expect(inspectWindowsPeerCredentials(pair.serverSocket, new AbortController().signal)).toBeUndefined()
      }
    } finally {
      await pair.close()
    }
  })

  it('verifies Windows private path ACL inspection fail-closed', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'win-acl-')))
    roots.push(dir)
    const file = join(dir, 'secret.key')
    await writeFile(file, 'dummy')

    expect(() => verifyWindowsPrivatePath('\\\\server\\share\\secret.key')).toThrow(/unsafe/)
    expect(() => verifyWindowsPrivatePath(file, {
      platform: 'win32',
      expectedOwnerSid: 'S-1-5-21-1000',
      checkAcl: () => ({ ownerSid: 'S-1-5-21-1000', protectedDacl: true, allowsNonOwner: true }),
    })).toThrow(/permissive/)
    expect(() => verifyWindowsPrivatePath(file, {
      platform: 'win32',
      expectedOwnerSid: 'S-1-5-21-1000',
      checkAcl: () => ({ ownerSid: 'S-1-5-21-9999', protectedDacl: true, allowsNonOwner: false }),
    })).toThrow(/SID mismatch/)
    expect(() => verifyWindowsPrivatePath(file, {
      platform: 'win32',
      expectedOwnerSid: 'S-1-5-21-1000',
      checkAcl: () => ({ ownerSid: 'S-1-5-21-1000', protectedDacl: true, allowsNonOwner: false }),
    })).not.toThrow()

    // Fail-closed when platform is win32 (or expectedOwnerSid is required) and checkAcl is omitted on Linux
    if (process.platform !== 'win32') {
      expect(() => verifyWindowsPrivatePath(file, {
        platform: 'win32',
        expectedOwnerSid: 'S-1-5-21-1000',
      })).toThrow(/Windows ACL inspection unavailable/)
      expect(() => verifyWindowsPrivatePath(file, {
        platform: 'win32',
      })).toThrow(/Windows ACL inspection unavailable/)
    }
    expect(() => verifyWindowsPrivatePath(file, {
      expectedOwnerSid: 'S-1-5-21-1000',
    })).toThrow(/Windows ACL inspection unavailable/)
  })

  it('parses Windows security descriptor owner SID, protected DACL, and ACE allow/deny entries fail-closed', () => {
    const ownerSidPtr = { ptr: 'owner' }
    const everyoneSidPtr = Buffer.from([1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0])
    const ownerSidBytes = Buffer.from([1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 0x20, 0x02, 0, 0])

    const makeAce = (type: number, mask: number, sidBytes: Buffer): Buffer => {
      const header = Buffer.alloc(8)
      header.writeUInt8(type, 0)
      header.writeUInt8(0, 1)
      header.writeUInt16LE(8 + sidBytes.length, 2)
      header.writeUInt32LE(mask, 4)
      return Buffer.concat([header, sidBytes])
    }

    const runInspector = (opts: {
      control: number
      daclPresent: number
      aces: Buffer[]
    }) => {
      const inspector = createWindowsAclInspectorFromRawApi({
        getFileSecurityW: (_path, _info, sd, len, neededOut) => {
          neededOut[0] = 64
          if (!sd || len < 64) return 0
          return 1
        },
        getSecurityDescriptorControl: (_sd, controlOut, revOut) => {
          controlOut[0] = opts.control
          revOut[0] = 1
          return 1
        },
        getSecurityDescriptorOwner: (_sd, ownerOut, defaultedOut) => {
          ownerOut[0] = ownerSidPtr
          defaultedOut[0] = 0
          return 1
        },
        getSecurityDescriptorDacl: (_sd, presentOut, daclOut, defaultedOut) => {
          presentOut[0] = opts.daclPresent
          daclOut[0] = opts.daclPresent ? { dacl: true } : null
          defaultedOut[0] = 0
          return 1
        },
        getAclInformation: (_dacl, buf) => {
          buf.writeUInt32LE(opts.aces.length, 0)
          return 1
        },
        getAce: (_dacl, idx, aceOut) => {
          aceOut[0] = opts.aces[idx]
          return opts.aces[idx] ? 1 : 0
        },
        readAceBytes: ptr => ptr as Buffer,
        convertSidToStringSidW: (sidPtr, out) => {
          if (sidPtr === ownerSidPtr || (Buffer.isBuffer(sidPtr) && sidPtr.equals(ownerSidBytes))) {
            out[0] = 'S-1-5-32-544'
            return 1
          }
          if (Buffer.isBuffer(sidPtr) && sidPtr.equals(everyoneSidPtr)) {
            out[0] = 'S-1-1-0'
            return 1
          }
          return 0
        },
        readWideStringAndFree: ptr => (typeof ptr === 'string' ? ptr : undefined),
      })
      return inspector('C:\\private\\secret.key')
    }

    // Protected DACL with only owner allow + non-owner deny -> safe
    expect(runInspector({
      control: 0x1000,
      daclPresent: 1,
      aces: [
        makeAce(1, 0x1f01ff, everyoneSidPtr), // ACCESS_DENIED_ACE
        makeAce(0, 0x1f01ff, ownerSidBytes),  // ACCESS_ALLOWED_ACE for owner
      ],
    })).toEqual({ ownerSid: 'S-1-5-32-544', protectedDacl: true, allowsNonOwner: false })

    // Unprotected DACL -> protectedDacl: false
    expect(runInspector({
      control: 0x0004,
      daclPresent: 1,
      aces: [makeAce(0, 0x1f01ff, ownerSidBytes)],
    })).toEqual({ ownerSid: 'S-1-5-32-544', protectedDacl: false, allowsNonOwner: false })

    // NULL / missing DACL -> allowsNonOwner: true
    expect(runInspector({
      control: 0x1000,
      daclPresent: 0,
      aces: [],
    })).toEqual({ ownerSid: 'S-1-5-32-544', protectedDacl: true, allowsNonOwner: true })

    // Non-owner allow ACE -> allowsNonOwner: true
    expect(runInspector({
      control: 0x1000,
      daclPresent: 1,
      aces: [
        makeAce(0, 0x1f01ff, ownerSidBytes),
        makeAce(0, 0x120089, everyoneSidPtr),
      ],
    })).toEqual({ ownerSid: 'S-1-5-32-544', protectedDacl: true, allowsNonOwner: true })

    // Unknown/object allow ACE -> fails closed with allowsNonOwner: true
    expect(runInspector({
      control: 0x1000,
      daclPresent: 1,
      aces: [makeAce(5, 0x1f01ff, ownerSidBytes)],
    })).toEqual({ ownerSid: 'S-1-5-32-544', protectedDacl: true, allowsNonOwner: true })
  })
})
