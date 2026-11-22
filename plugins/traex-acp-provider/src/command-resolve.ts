import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type { AcpBackend } from './acp-client.js'

export interface ResolveAcpCommandOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly homeDir?: string
  readonly isExecutable?: (candidatePath: string) => boolean
}

export type AcpCommandResolver = (
  command: string,
  backend: AcpBackend,
  options?: ResolveAcpCommandOptions,
) => string

function hasPathSeparator(command: string, platform: NodeJS.Platform): boolean {
  if (command.includes('/') || command.includes('\\')) return true
  return platform === 'win32' && /^[A-Za-z]:/u.test(command)
}

function defaultIsExecutable(candidatePath: string, platform: NodeJS.Platform): boolean {
  try {
    const st = statSync(candidatePath)
    if (!st.isFile()) return false
    return platform === 'win32' || (st.mode & 0o111) !== 0
  } catch {
    return false
  }
}

function candidateNames(command: string, platform: NodeJS.Platform): readonly string[] {
  if (platform !== 'win32') return [command]
  if (/\.(?:cmd|exe|bat)$/iu.test(command)) return [command]
  return [`${command}.cmd`, `${command}.exe`, command]
}

/**
 * Resolve a bare ACP executable name (e.g. `traex`, `agy`) across `PATH` and standard user/OS
 * install locations so GUI apps and launchd/systemd services lacking an interactive shell `PATH`
 * can still locate local CLIs. Explicit paths (containing any path separator) are returned
 * verbatim with no fallback; bare names not found anywhere are returned unchanged so callers
 * preserve standard `ENOENT -> CLI_NOT_FOUND` diagnostics.
 */
export function resolveAcpCommand(
  command: string,
  backend: AcpBackend,
  options: ResolveAcpCommandOptions = {},
): string {
  const trimmed = command.trim()
  const platform = options.platform ?? process.platform
  if (trimmed === '' || hasPathSeparator(trimmed, platform)) {
    return command
  }

  const env = options.env ?? process.env
  const pathOps = platform === 'win32' ? win32 : posix
  const pathDelimiter = platform === 'win32' ? ';' : ':'
  const home = options.homeDir ?? (
    (platform === 'win32' ? env.USERPROFILE?.trim() : env.HOME?.trim()) || homedir()
  )

  const dirs: string[] = []
  const pushDir = (dir: string | undefined): void => {
    if (typeof dir !== 'string') return
    const clean = dir.trim()
    if (clean === '' || !pathOps.isAbsolute(clean)) return
    const normalized = pathOps.resolve(clean)
    if (!dirs.includes(normalized)) dirs.push(normalized)
  }

  // Always check explicit PATH first so user overrides take precedence.
  for (const entry of (env.PATH ?? '').split(pathDelimiter)) {
    pushDir(entry)
  }

  if (platform === 'win32') {
    if (env.APPDATA) pushDir(pathOps.join(env.APPDATA, 'npm'))
    if (env.LOCALAPPDATA) {
      if (backend === 'agy') {
        pushDir(pathOps.join(env.LOCALAPPDATA, 'Programs', 'Antigravity', 'bin'))
      } else {
        pushDir(pathOps.join(env.LOCALAPPDATA, 'Programs', 'Trae', 'bin'))
      }
    }
    if (home) pushDir(pathOps.join(home, '.local', 'bin'))
  } else {
    if (home) {
      pushDir(pathOps.join(home, '.local', 'bin'))
      if (backend === 'agy') {
        pushDir(pathOps.join(home, '.antigravity', 'antigravity', 'bin'))
      }
      pushDir(pathOps.join(home, '.npm-global', 'bin'))
      pushDir(pathOps.join(home, 'Library', 'pnpm'))
    }
    pushDir('/opt/homebrew/bin')
    pushDir('/usr/local/bin')
    pushDir('/usr/bin')
  }

  const check = options.isExecutable ?? (candidate => defaultIsExecutable(candidate, platform))
  const names = candidateNames(trimmed, platform)
  for (const dir of dirs) {
    for (const fileName of names) {
      const candidate = pathOps.join(dir, fileName)
      if (check(candidate)) return candidate
    }
  }
  return command
}
