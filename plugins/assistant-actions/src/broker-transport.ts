import { randomUUID } from 'node:crypto'
import { chmod, chown, lstat, realpath, rename, unlink } from 'node:fs/promises'
import { createConnection, type Server, type Socket } from 'node:net'
import { dirname, isAbsolute, resolve } from 'node:path'
import { inspectLinuxPeerCredentials, linuxPeerCredentialsAvailable } from './broker-peer-linux.js'
import { inspectMacosPeerCredentials, macosPeerCredentialsAvailable } from './broker-peer-macos.js'
import {
  inspectWindowsPeerCredentials,
  inspectWindowsServerPeerCredentials,
  isWindowsNamedPipePath,
  windowsPeerCredentialsAvailable,
} from './broker-peer-windows.js'
import type { BrokerPeerCredentialInspector, BrokerPeerCredentials } from './broker-server.js'

export type BrokerPlatform = 'auto' | 'linux' | 'darwin' | 'win32'
export type BrokerResolvedPlatform = 'linux' | 'darwin' | 'win32'
export type BrokerTransportKind = 'posix-uds' | 'windows-pipe'

export interface BrokerTransportEndpointSpec {
  readonly path: string
  readonly uid: number
  readonly gid: number
  readonly parentMode: number
  readonly mode: number
}

export interface BrokerTransportClientInspectOptions {
  readonly socketPath: string
  readonly expectedSocketUid?: number
  readonly expectedSocketGid?: number
  readonly expectedSocketMode?: number
  readonly expectedSocketParentUid?: number
  readonly expectedSocketParentGid?: number
  readonly expectedSocketParentMode?: number
}

export interface BrokerTransportAdapter {
  readonly kind: BrokerTransportKind
  readonly platform: BrokerResolvedPlatform
  readonly inspectPeer: BrokerPeerCredentialInspector
  validateEndpointPath(path: string): void
  inspectParent(endpoint: BrokerTransportEndpointSpec): Promise<unknown>
  inspectSocket(endpoint: BrokerTransportEndpointSpec): Promise<unknown | undefined>
  sameIdentity(left: unknown, right: unknown): boolean
  sameInode(left: unknown, right: unknown): boolean
  removeStale(endpoint: BrokerTransportEndpointSpec, before: unknown, probe: (path: string) => Promise<'active' | 'refused' | 'untrusted'>): Promise<void>
  listen(server: Server, path: string): Promise<void>
  finalizeSocket(endpoint: BrokerTransportEndpointSpec, afterParent: unknown): Promise<unknown>
  closeOwned(endpoint: BrokerTransportEndpointSpec, server: Server, owned: unknown | undefined, deadlineAt: number, now: () => number): Promise<void>
  unlinkOwned(endpoint: BrokerTransportEndpointSpec, owned: unknown | undefined): Promise<void>
  inspectClientEndpoint(options: BrokerTransportClientInspectOptions): Promise<unknown>
  assertClientEndpointUnchanged(options: BrokerTransportClientInspectOptions, before: unknown): Promise<void>
  connect(path: string): Socket
}

export class BrokerTransportError extends Error {
  constructor(
    readonly code: 'invalid-config' | 'unsafe-parent' | 'unsafe-socket' | 'already-running' | 'socket-invalid' | 'socket-changed' | 'shutdown-failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'BrokerTransportError'
  }
}

interface FileIdentity {
  readonly dev: bigint
  readonly ino: bigint
  readonly uid: bigint
  readonly gid: bigint
  readonly mode: number
}

interface ClientSocketIdentity {
  readonly dev: bigint
  readonly ino: bigint
  readonly uid: bigint
  readonly gid: bigint
  readonly mode: number
  readonly parentDev: bigint
  readonly parentIno: bigint
  readonly parentUid: bigint
  readonly parentGid: bigint
  readonly parentMode: number
}

const enoent = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
function fileIdentity(stat: Awaited<ReturnType<typeof lstat>>): FileIdentity {
  return { dev: BigInt(stat.dev), ino: BigInt(stat.ino), uid: BigInt(stat.uid), gid: BigInt(stat.gid), mode: Number(stat.mode) & 0o7777 }
}
function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode
}
function sameFileInode(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function timer(callback: () => void, timeoutMs: number): ReturnType<typeof setTimeout> {
  const handle = setTimeout(callback, timeoutMs)
  handle.unref()
  return handle
}

async function closeServer(server: Server, deadlineAt: number, now: () => number): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolveClose, rejectClose) => {
    const handle = timer(() => rejectClose(new BrokerTransportError('shutdown-failed', 'listener close deadline exceeded')), Math.max(1, deadlineAt - now()))
    server.close(error => {
      clearTimeout(handle)
      if (error) rejectClose(error)
      else resolveClose()
    })
  })
}

export function resolveBrokerPlatform(value: BrokerPlatform = 'auto', runtimePlatform: NodeJS.Platform = process.platform): BrokerResolvedPlatform {
  const target = value === 'auto' ? runtimePlatform : value
  if (target === 'linux' || target === 'darwin' || target === 'win32') return target
  throw new BrokerTransportError('invalid-config', `unsupported broker platform: ${String(target)}`)
}

export function resolveBrokerTransportKind(
  platform: BrokerPlatform = 'auto',
  transport: 'auto' | BrokerTransportKind = 'auto',
  runtimePlatform: NodeJS.Platform = process.platform,
): BrokerTransportKind {
  if (transport === 'posix-uds' || transport === 'windows-pipe') return transport
  const resolved = resolveBrokerPlatform(platform, runtimePlatform)
  return resolved === 'win32' ? 'windows-pipe' : 'posix-uds'
}

export function platformPeerCredentialsAvailable(
  platform: BrokerPlatform = 'auto',
  deps: {
    readonly runtimePlatform?: NodeJS.Platform
    readonly linuxAvailable?: () => boolean
    readonly macosAvailable?: () => boolean
    readonly windowsAvailable?: () => boolean
  } = {},
): boolean {
  let resolved: BrokerResolvedPlatform
  try {
    resolved = resolveBrokerPlatform(platform, deps.runtimePlatform ?? process.platform)
  } catch {
    return false
  }
  if (resolved === 'linux') return (deps.linuxAvailable ?? linuxPeerCredentialsAvailable)()
  if (resolved === 'darwin') return (deps.macosAvailable ?? macosPeerCredentialsAvailable)()
  return (deps.windowsAvailable ?? windowsPeerCredentialsAvailable)()
}

export function inspectPlatformPeerCredentials(
  platform: BrokerPlatform = 'auto',
  role: 'client' | 'server' = 'client',
  deps: {
    readonly runtimePlatform?: NodeJS.Platform
    readonly linuxInspector?: BrokerPeerCredentialInspector
    readonly macosInspector?: BrokerPeerCredentialInspector
    readonly windowsClientInspector?: BrokerPeerCredentialInspector
    readonly windowsServerInspector?: BrokerPeerCredentialInspector
  } = {},
): BrokerPeerCredentialInspector {
  const resolved = resolveBrokerPlatform(platform, deps.runtimePlatform ?? process.platform)
  if (resolved === 'linux') return deps.linuxInspector ?? inspectLinuxPeerCredentials
  if (resolved === 'darwin') return deps.macosInspector ?? inspectMacosPeerCredentials
  return role === 'server'
    ? (deps.windowsServerInspector ?? inspectWindowsServerPeerCredentials)
    : (deps.windowsClientInspector ?? inspectWindowsPeerCredentials)
}

export function matchesPeerIdentity(
  peer: BrokerPeerCredentials | undefined,
  expected: { uid?: number; gid?: number; sid?: string },
  transportKind: BrokerTransportKind = 'posix-uds',
): boolean {
  if (!peer) return false
  if (peer.pid !== undefined && !integer(peer.pid, 1, 0x7fffffff)) return false
  if (transportKind === 'windows-pipe') {
    if (typeof peer.sid !== 'string' || !/^S-1-(?:\d+-)*\d+$/u.test(peer.sid)) return false
    if (expected.sid !== undefined && peer.sid !== expected.sid) return false
    return true
  }
  if (!integer(peer.uid, 0, 0x7fffffff) || !integer(peer.gid, 0, 0x7fffffff)) return false
  if (expected.uid !== undefined && peer.uid !== expected.uid) return false
  if (expected.gid !== undefined && peer.gid !== expected.gid) return false
  return true
}

export function createPosixUdsTransportAdapter(
  platform: 'linux' | 'darwin' = 'linux',
  inspectPeer: BrokerPeerCredentialInspector = platform === 'darwin' ? inspectMacosPeerCredentials : inspectLinuxPeerCredentials,
): BrokerTransportAdapter {
  const inspectParentFn = async (endpoint: BrokerTransportEndpointSpec): Promise<FileIdentity> => {
    const parent = dirname(endpoint.path)
    let cursor = parent
    for (;;) {
      const [canonicalCursor, cursorStat] = await Promise.all([realpath(cursor), lstat(cursor)])
      const mode = cursorStat.mode & 0o7777
      const stickyRoot = cursorStat.uid === 0 && (mode & 0o1000) !== 0 && (mode & 0o022) !== 0
      if (canonicalCursor !== cursor || cursorStat.isSymbolicLink() || !cursorStat.isDirectory() || (!stickyRoot && (mode & 0o022) !== 0)) {
        throw new BrokerTransportError('unsafe-parent', 'socket ancestor is unsafe')
      }
      const next = dirname(cursor)
      if (next === cursor) break
      cursor = next
    }
    let canonical: string
    let stat: Awaited<ReturnType<typeof lstat>>
    try {
      [canonical, stat] = await Promise.all([realpath(parent), lstat(parent)])
    } catch (error) {
      throw new BrokerTransportError('unsafe-parent', 'socket parent cannot be inspected', { cause: error })
    }
    if (canonical !== parent || stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== endpoint.uid || stat.gid !== endpoint.gid || (stat.mode & 0o7777) !== endpoint.parentMode) {
      throw new BrokerTransportError('unsafe-parent', 'socket parent type, ownership, or mode is unsafe')
    }
    return fileIdentity(stat)
  }

  const inspectSocketFn = async (endpoint: BrokerTransportEndpointSpec): Promise<FileIdentity | undefined> => {
    let stat: Awaited<ReturnType<typeof lstat>>
    try {
      stat = await lstat(endpoint.path)
    } catch (error) {
      if (enoent(error)) return undefined
      throw new BrokerTransportError('unsafe-socket', 'socket path cannot be inspected', { cause: error })
    }
    if (stat.isSymbolicLink() || !stat.isSocket() || stat.uid !== endpoint.uid || stat.gid !== endpoint.gid || (stat.mode & 0o7777) !== endpoint.mode) {
      throw new BrokerTransportError('unsafe-socket', 'socket type, ownership, or mode is unsafe')
    }
    return fileIdentity(stat)
  }

  const inspectClientFn = async (options: BrokerTransportClientInspectOptions): Promise<ClientSocketIdentity> => {
    const path = options.socketPath
    if (!isAbsolute(path) || resolve(path) !== path || path === '/') {
      throw new BrokerTransportError('invalid-config', 'canonical absolute socket path required')
    }
    const parentPath = dirname(path)
    let canonical: string, canonicalParent: string
    let stat: Awaited<ReturnType<typeof lstat>>, after: Awaited<ReturnType<typeof lstat>>
    let parent: Awaited<ReturnType<typeof lstat>>, parentAfter: Awaited<ReturnType<typeof lstat>>
    try {
      stat = await lstat(path, { bigint: true })
      parent = await lstat(parentPath, { bigint: true })
      canonical = await realpath(path)
      canonicalParent = await realpath(parentPath)
      after = await lstat(path, { bigint: true })
      parentAfter = await lstat(parentPath, { bigint: true })
    } catch (error) {
      throw new BrokerTransportError('socket-invalid', 'socket cannot be inspected', { cause: error })
    }
    if (canonical !== path || stat.isSymbolicLink() || !stat.isSocket() || after.isSymbolicLink() || !after.isSocket()
      || stat.dev !== after.dev || stat.ino !== after.ino || stat.uid !== after.uid || stat.gid !== after.gid || stat.mode !== after.mode) {
      throw new BrokerTransportError('socket-invalid', 'socket path must name one stable canonical Unix socket directly')
    }
    const uid = BigInt(options.expectedSocketUid ?? process.getuid?.() ?? -1)
    const gid = BigInt(options.expectedSocketGid ?? process.getgid?.() ?? -1)
    const mode = options.expectedSocketMode ?? 0o600
    const parentUid = BigInt(options.expectedSocketParentUid ?? options.expectedSocketUid ?? process.getuid?.() ?? -1)
    const parentGid = BigInt(options.expectedSocketParentGid ?? options.expectedSocketGid ?? process.getgid?.() ?? -1)
    const parentMode = options.expectedSocketParentMode ?? 0o700
    if (!integer(mode, 0, 0o777) || (mode & 0o007) !== 0 || !integer(parentMode, 0, 0o777) || (parentMode & 0o022) !== 0
      || stat.uid !== uid || stat.gid !== gid || Number(stat.mode & 0o7777n) !== mode
      || canonicalParent !== parentPath || !parent.isDirectory() || parent.isSymbolicLink() || !parentAfter.isDirectory() || parentAfter.isSymbolicLink()
      || parent.dev !== parentAfter.dev || parent.ino !== parentAfter.ino || parent.uid !== parentAfter.uid || parent.gid !== parentAfter.gid || parent.mode !== parentAfter.mode
      || parent.uid !== parentUid || parent.gid !== parentGid || Number(parent.mode & 0o7777n) !== parentMode) {
      throw new BrokerTransportError('socket-invalid', 'socket or parent ownership and mode do not match the pinned identity')
    }
    return {
      dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: Number(stat.mode & 0o7777n),
      parentDev: parent.dev, parentIno: parent.ino, parentUid: parent.uid, parentGid: parent.gid, parentMode: Number(parent.mode & 0o7777n),
    }
  }

  return {
    kind: 'posix-uds',
    platform,
    inspectPeer,
    validateEndpointPath(path) {
      if (!isAbsolute(path) || resolve(path) !== path || dirname(path) === path || path.includes('\0') || Buffer.byteLength(path) > 100) {
        throw new BrokerTransportError('invalid-config', 'socket endpoint is invalid')
      }
    },
    inspectParent: inspectParentFn,
    inspectSocket: inspectSocketFn,
    sameIdentity: (left, right) => sameFileIdentity(left as FileIdentity, right as FileIdentity),
    sameInode: (left, right) => sameFileInode(left as FileIdentity, right as FileIdentity),
    async removeStale(endpoint, before, probe) {
      const result = await probe(endpoint.path)
      if (result === 'active') throw new BrokerTransportError('already-running', 'an authenticated broker is already listening')
      if (result !== 'refused') throw new BrokerTransportError('unsafe-socket', 'existing socket cannot be authenticated or proven stale')
      const after = await inspectSocketFn(endpoint)
      if (!after || !sameFileIdentity(before as FileIdentity, after)) {
        throw new BrokerTransportError('unsafe-socket', 'socket changed during stale inspection')
      }
      await unlink(endpoint.path).catch(error => {
        throw new BrokerTransportError('unsafe-socket', 'stale socket cannot be removed', { cause: error })
      })
    },
    async listen(server, path) {
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (error: Error): void => { server.off('listening', onListen); rejectListen(error) }
        const onListen = (): void => { server.off('error', onError); resolveListen() }
        server.once('error', onError)
        server.once('listening', onListen)
        server.listen(path)
      })
    },
    async finalizeSocket(endpoint, afterParent) {
      const provisional = await lstat(endpoint.path)
      if (provisional.isSymbolicLink() || !provisional.isSocket()) {
        throw new BrokerTransportError('unsafe-socket', 'newly bound path is not a socket')
      }
      const provisionalId = fileIdentity(provisional)
      await chown(endpoint.path, endpoint.uid, endpoint.gid)
      await chmod(endpoint.path, endpoint.mode)
      const [socket, finalParent] = await Promise.all([inspectSocketFn(endpoint), inspectParentFn(endpoint)])
      if (!socket || !sameFileIdentity(afterParent as FileIdentity, finalParent)) {
        throw new BrokerTransportError('unsafe-socket', 'bound socket identity could not be verified')
      }
      if (!sameFileInode(provisionalId, socket)) {
        throw new BrokerTransportError('unsafe-socket', 'bound socket inode changed during startup')
      }
      return socket
    },
    async closeOwned(endpoint, server, owned, deadlineAt, now) {
      const ownedIdentity = owned as FileIdentity | undefined
      if (!ownedIdentity) {
        await closeServer(server, deadlineAt, now)
        return
      }
      const parked = `${endpoint.path}.replacement-${randomUUID()}`
      let parkedIdentity: FileIdentity | undefined
      let parkedExists = false
      let problem: unknown
      try {
        try { await rename(endpoint.path, parked); parkedExists = true } catch (error) { if (!enoent(error)) throw error }
        const stat = await lstat(parked).catch(error => enoent(error) ? undefined : Promise.reject(error))
        if (stat) {
          parkedIdentity = fileIdentity(stat)
          if (!sameFileInode(parkedIdentity, ownedIdentity) && (stat.isSymbolicLink() || !stat.isSocket() || stat.uid !== endpoint.uid || stat.gid !== endpoint.gid || (stat.mode & 0o7777) !== endpoint.mode)) {
            throw new BrokerTransportError('shutdown-failed', 'parked socket is unsafe')
          }
        }
      } catch (error) { problem = error }
      try { await closeServer(server, deadlineAt, now) } catch (error) { problem ??= error }
      try {
        if (parkedIdentity && sameFileInode(parkedIdentity, ownedIdentity)) await unlink(parked)
        else if (parkedIdentity) {
          if (await lstat(endpoint.path).then(() => true, error => enoent(error) ? false : Promise.reject(error))
            || !sameFileIdentity(parkedIdentity, fileIdentity(await lstat(parked)))) {
            throw new BrokerTransportError('shutdown-failed', 'replacement socket cannot be restored')
          }
          await rename(parked, endpoint.path)
          if (!sameFileIdentity(parkedIdentity, fileIdentity(await lstat(endpoint.path)))) {
            throw new BrokerTransportError('shutdown-failed', 'replacement socket changed')
          }
        }
      } catch (error) { problem ??= error }
      if (problem !== undefined) {
        if (parkedExists && parkedIdentity && sameFileInode(parkedIdentity, ownedIdentity)) await unlink(parked).catch(() => undefined)
        else if (parkedExists) {
          const destinationMissing = await lstat(endpoint.path).then(() => false, error => enoent(error))
          if (destinationMissing) await rename(parked, endpoint.path).catch(() => undefined)
        }
        if (problem instanceof BrokerTransportError) throw problem
        throw new BrokerTransportError('shutdown-failed', 'socket preservation failed', { cause: problem })
      }
    },
    async unlinkOwned(endpoint, owned) {
      const ownedIdentity = owned as FileIdentity | undefined
      if (!ownedIdentity) return
      const current = await inspectSocketFn(endpoint).catch(() => undefined)
      if (current && sameFileIdentity(current, ownedIdentity) && await inspectParentFn(endpoint).catch(() => undefined)) {
        await unlink(endpoint.path).catch(() => undefined)
      }
    },
    inspectClientEndpoint: inspectClientFn,
    async assertClientEndpointUnchanged(options, before) {
      const prev = before as ClientSocketIdentity
      let after: ClientSocketIdentity
      try {
        after = await inspectClientFn(options)
      } catch (error) {
        throw new BrokerTransportError('socket-changed', 'socket changed while connecting', { cause: error })
      }
      if (after.dev !== prev.dev || after.ino !== prev.ino || after.uid !== prev.uid || after.gid !== prev.gid || after.mode !== prev.mode
        || after.parentDev !== prev.parentDev || after.parentIno !== prev.parentIno || after.parentUid !== prev.parentUid || after.parentGid !== prev.parentGid || after.parentMode !== prev.parentMode) {
        throw new BrokerTransportError('socket-changed', 'socket identity changed while connecting')
      }
    },
    connect: path => createConnection({ path }),
  }
}

export function createWindowsPipeTransportAdapter(
  inspectPeer: BrokerPeerCredentialInspector = inspectWindowsPeerCredentials,
  hooks: {
    readonly listen?: (server: Server, path: string) => Promise<void>
    readonly connect?: (path: string) => Socket
  } = {},
): BrokerTransportAdapter {
  const validatePipe = (path: string): void => {
    if (!isWindowsNamedPipePath(path)) {
      throw new BrokerTransportError('invalid-config', 'Windows named pipe path must match \\\\.\\pipe\\<name>')
    }
  }
  return {
    kind: 'windows-pipe',
    platform: 'win32',
    inspectPeer,
    validateEndpointPath: validatePipe,
    async inspectParent(endpoint) {
      validatePipe(endpoint.path)
      return { pipePath: endpoint.path }
    },
    async inspectSocket(endpoint) {
      validatePipe(endpoint.path)
      return undefined
    },
    sameIdentity: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    sameInode: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    async removeStale(endpoint, _before, probe) {
      const result = await probe(endpoint.path)
      if (result === 'active') throw new BrokerTransportError('already-running', 'an authenticated broker is already listening on named pipe')
    },
    async listen(server, path) {
      validatePipe(path)
      if (hooks.listen) {
        await hooks.listen(server, path)
        return
      }
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (error: Error): void => { server.off('listening', onListen); rejectListen(error) }
        const onListen = (): void => { server.off('error', onError); resolveListen() }
        server.once('error', onError)
        server.once('listening', onListen)
        server.listen(path)
      })
    },
    async finalizeSocket(endpoint) {
      validatePipe(endpoint.path)
      return { pipePath: endpoint.path }
    },
    async closeOwned(_endpoint, server, _owned, deadlineAt, now) {
      await closeServer(server, deadlineAt, now)
    },
    async unlinkOwned() {
      // Named pipes are kernel-managed and destroyed automatically when handles close.
    },
    async inspectClientEndpoint(options) {
      validatePipe(options.socketPath)
      return { pipePath: options.socketPath }
    },
    async assertClientEndpointUnchanged(options, before) {
      validatePipe(options.socketPath)
      if ((before as { pipePath?: string } | undefined)?.pipePath !== options.socketPath) {
        throw new BrokerTransportError('socket-changed', 'named pipe path changed while connecting')
      }
    },
    connect(path) {
      validatePipe(path)
      return hooks.connect ? hooks.connect(path) : createConnection({ path })
    },
  }
}

export function createBrokerTransportAdapter(options: {
  readonly platform?: BrokerPlatform
  readonly transport?: 'auto' | BrokerTransportKind
  readonly role?: 'client' | 'server'
  readonly inspectPeer?: BrokerPeerCredentialInspector
  readonly runtimePlatform?: NodeJS.Platform
} = {}): BrokerTransportAdapter {
  const resolvedPlatform = resolveBrokerPlatform(options.platform ?? 'auto', options.runtimePlatform ?? process.platform)
  const kind = resolveBrokerTransportKind(resolvedPlatform, options.transport ?? 'auto', resolvedPlatform)
  const inspector = options.inspectPeer ?? inspectPlatformPeerCredentials(resolvedPlatform, options.role ?? 'client', { runtimePlatform: resolvedPlatform })
  if (kind === 'windows-pipe') return createWindowsPipeTransportAdapter(inspector)
  return createPosixUdsTransportAdapter(resolvedPlatform === 'darwin' ? 'darwin' : 'linux', inspector)
}
