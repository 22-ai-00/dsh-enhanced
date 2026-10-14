import { lstatSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export interface DockerSocket { path: string; dev: number; ino: number }

export function configuredDockerSocketPath(path: string | undefined, platform = process.platform, home = homedir()): string {
  const value = path ?? (platform === 'darwin' ? join(home, '.docker', 'run', 'docker.sock') : '/var/run/docker.sock')
  if (!isAbsolute(value) || resolve(value) !== value || /[\p{Cc},]/u.test(value) || value.includes('://')) throw new Error('assistant-isolation: canonical absolute local Docker socket required')
  if (platform === 'darwin') {
    const directory = join(home, '.docker', 'run')
    if (value !== join(directory, 'docker.sock')) {
      throw new Error('assistant-isolation: macOS Docker socket must be in the current user Docker run directory')
    }
  }
  return value
}

/** Resolve once for a job and retain the inode through supervisor and cleanup. */
export function resolveLocalDockerSocket(path: string, platform = process.platform, home = homedir()): DockerSocket {
  configuredDockerSocketPath(path, platform, home)
  const canonical = realpathSync(path)
  if (platform === 'darwin' && canonical !== path) throw new Error('assistant-isolation: macOS Docker socket must not be a symlink')
  const info = lstatSync(canonical)
  if (!info.isSocket()) throw new Error('assistant-isolation: Docker endpoint is not a local Unix socket')
  if (platform === 'darwin') {
    const directory = join(home, '.docker', 'run')
    const parent = statSync(directory)
    if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o022) !== 0 || info.uid !== process.getuid?.()) {
      throw new Error('assistant-isolation: macOS Docker socket must be owned by the current user')
    }
  }
  return { path: canonical, dev: info.dev, ino: info.ino }
}

export function sameLocalDockerSocket(socket: DockerSocket): boolean {
  try {
    const info = lstatSync(socket.path)
    return info.isSocket() && info.dev === socket.dev && info.ino === socket.ino
  } catch { return false }
}
