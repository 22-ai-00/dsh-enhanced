import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { configuredDockerSocketPath } from './docker-socket.js'

const filename = 'docker-socket-path'

function readBinding(stateRoot: string): string | undefined {
  const file = join(stateRoot, filename)
  if (!existsSync(file)) return undefined
  const info = lstatSync(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 4096) {
    throw new Error('assistant-isolation: invalid state Docker socket binding')
  }
  const value = readFileSync(file, 'utf8')
  if (!value.endsWith('\n') || value.slice(0, -1) !== configuredDockerSocketPath(value.slice(0, -1))) {
    throw new Error('assistant-isolation: invalid state Docker socket binding')
  }
  return value.slice(0, -1)
}

/** Legacy state roots were Linux-only and always used the default socket. */
export function stateSocketBindingMatches(stateRoot: string, socketPath: string): boolean {
  try {
    if (existsSync(join(stateRoot, 'native-backend'))) return false
    const existing = readBinding(stateRoot)
    return existing === undefined ? process.platform === 'linux' && socketPath === '/var/run/docker.sock' : existing === socketPath
  } catch { return false }
}

export function bindIsolationStateSocket(stateRoot: string, socketPath: string): void {
  configuredDockerSocketPath(socketPath)
  if (existsSync(join(stateRoot, 'native-backend'))) throw new Error('assistant-isolation: state root is native-bound')
  const existing = readBinding(stateRoot)
  if (existing !== undefined) {
    if (existing !== socketPath) throw new Error('assistant-isolation: state root is bound to a different Docker socket')
    return
  }
  if (existsSync(join(stateRoot, 'ledger.sqlite')) && !stateSocketBindingMatches(stateRoot, socketPath)) {
    throw new Error('assistant-isolation: legacy state root requires its original Linux Docker socket')
  }
  const file = join(stateRoot, filename)
  let handle: number
  try { handle = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST' && stateSocketBindingMatches(stateRoot, socketPath)) return
    throw error
  }
  try {
    const bytes = Buffer.from(`${socketPath}\n`)
    if (writeSync(handle, bytes) !== bytes.length || !fstatSync(handle).isFile()) throw new Error('assistant-isolation: cannot persist Docker socket binding')
    fsyncSync(handle)
  } finally { closeSync(handle) }
}
