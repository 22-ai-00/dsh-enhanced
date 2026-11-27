import { constants, existsSync } from 'node:fs'
import { access, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'

/** Return true when `execPath` points to a Node binary rather than an Electron GUI binary. */
export function isNodeExecutablePath(execPath: string): boolean {
  const base = basename(execPath).toLowerCase()
  return base === 'node' || base.startsWith('node.') || base.startsWith('node-')
}

/** Verify `filePath` exists as a regular file (following symlinks) with the requested access bits. */
export async function checkRegularFileAccess(filePath: string, modeMask: number): Promise<boolean> {
  try {
    await access(filePath, modeMask)
    return (await stat(filePath)).isFile()
  } catch {
    return false
  }
}

function parseNvmVersion(name: string): readonly [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(name.trim())
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** List existing `~/.nvm/versions/node/<ver>/bin` directories sorted newest-first by SemVer. */
export async function listNvmNodeBinDirs(osHome: string): Promise<string[]> {
  const versionsRoot = join(osHome, '.nvm', 'versions', 'node')
  let entries: string[]
  try {
    entries = await readdir(versionsRoot)
  } catch {
    return []
  }
  const sorted = [...entries].sort((left, right) => {
    const a = parseNvmVersion(left)
    const b = parseNvmVersion(right)
    if (a && b) {
      for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return b[i]! - a[i]!
      }
      return left.localeCompare(right)
    }
    if (a) return -1
    if (b) return 1
    return right.localeCompare(left)
  })
  return sorted.map(name => join(versionsRoot, name, 'bin'))
}

/** Standard fallback binary directories for GUI/launchd/systemd child processes with stripped `PATH`. */
export function collectFallbackBinDirs(
  osHome: string,
  platform: NodeJS.Platform,
  nvmDirs: readonly string[] = [],
): string[] {
  return [
    join(osHome, '.local', 'bin'),
    join(osHome, '.npm-global', 'bin'),
    join(osHome, '.local', 'share', 'pnpm'),
    ...(platform === 'darwin' ? [join(osHome, 'Library', 'pnpm'), '/opt/homebrew/bin'] : []),
    '/usr/local/bin',
    join(osHome, '.volta', 'bin'),
    join(osHome, '.asdf', 'shims'),
    join(osHome, '.local', 'share', 'mise', 'shims'),
    join(osHome, '.fnm', 'aliases', 'default', 'bin'),
    ...(platform === 'darwin'
      ? [join(osHome, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin')]
      : [join(osHome, '.local', 'share', 'fnm', 'aliases', 'default', 'bin')]),
    ...nvmDirs,
  ]
}

async function findExecutableInDirs(name: string, dirs: readonly string[]): Promise<string | undefined> {
  const seen = new Set<string>()
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    const candidate = join(dir, name)
    if (await checkRegularFileAccess(candidate, constants.X_OK)) {
      return candidate
    }
  }
  return undefined
}

/**
 * Resolve a Node runtime executable capable of running CLI scripts (`node` binary first, or
 * `DSH_DESKTOP_NODE_EXECUTABLE` / `process.execPath` with `ELECTRON_RUN_AS_NODE=1` when Electron).
 */
export async function resolveNodeRuntime(
  env: NodeJS.ProcessEnv,
  osHome: string,
  platform: NodeJS.Platform,
): Promise<{ command: string; envOverrides: NodeJS.ProcessEnv; binDir?: string }> {
  const desktopExec = env.DSH_DESKTOP_NODE_EXECUTABLE?.trim()
  if (desktopExec && await checkRegularFileAccess(desktopExec, constants.X_OK)) {
    return {
      command: desktopExec,
      envOverrides: isNodeExecutablePath(desktopExec) ? {} : { ELECTRON_RUN_AS_NODE: '1' },
      ...(isNodeExecutablePath(desktopExec) ? { binDir: dirname(desktopExec) } : {}),
    }
  }
  if (isNodeExecutablePath(process.execPath)) {
    return {
      command: process.execPath,
      envOverrides: {},
      binDir: dirname(process.execPath),
    }
  }
  const nvmDirs = await listNvmNodeBinDirs(osHome)
  const searchDirs = [
    ...(env.PATH ?? '').split(delimiter).filter(Boolean),
    ...collectFallbackBinDirs(osHome, platform, nvmDirs),
  ]
  const foundNode = await findExecutableInDirs('node', searchDirs)
  if (foundNode) {
    return {
      command: foundNode,
      envOverrides: {},
      binDir: dirname(foundNode),
    }
  }
  return {
    command: process.execPath,
    envOverrides: { ELECTRON_RUN_AS_NODE: '1' },
  }
}

/**
 * Resolve an executable (`npm`, etc.). Preserves bare `name` when already discoverable on caller
 * `PATH` so tests mocking `PATH` + bare binary names continue receiving expected command names;
 * falls back to standard user/nvm/homebrew dirs when caller `PATH` is stripped (e.g. macOS GUI).
 */
export async function resolveFallbackBinary(
  name: string,
  env: NodeJS.ProcessEnv,
  osHome: string,
  platform: NodeJS.Platform,
  extraDirs: readonly string[] = [],
): Promise<{ command: string; binDir?: string }> {
  const pathDirs = (env.PATH ?? '').split(delimiter).filter(Boolean)
  const onPath = await findExecutableInDirs(name, pathDirs)
  if (onPath) {
    return { command: name }
  }
  const nvmDirs = await listNvmNodeBinDirs(osHome)
  const fallbackDirs = [...extraDirs, ...collectFallbackBinDirs(osHome, platform, nvmDirs)]
  const resolved = await findExecutableInDirs(name, fallbackDirs)
  if (resolved) {
    return { command: resolved, binDir: dirname(resolved) }
  }
  return { command: name }
}

/**
 * Build non-TTY-safe environment for child `pnpm` / `npm` processes: sets `CI=true`, preserves caller
 * `PATH` precedence first, and appends resolved Node + standard user binary dirs that exist on disk.
 */
export async function buildPackageManagerEnv(
  env: NodeJS.ProcessEnv,
  osHome: string = env.HOME ?? homedir(),
  platform: NodeJS.Platform = process.platform,
  extraBinDirs: readonly string[] = [],
): Promise<NodeJS.ProcessEnv> {
  const nvmDirs = await listNvmNodeBinDirs(osHome)
  const nodeRuntime = await resolveNodeRuntime(env, osHome, platform)
  const existingEntries = (env.PATH ?? '').split(delimiter).filter(Boolean)
  const merged: string[] = [...existingEntries]
  const seen = new Set(existingEntries)

  const appendIfExisting = (dir: string | undefined) => {
    if (!dir || seen.has(dir) || !existsSync(dir)) return
    seen.add(dir)
    merged.push(dir)
  }

  for (const dir of extraBinDirs) appendIfExisting(dir)
  appendIfExisting(nodeRuntime.binDir)
  for (const dir of collectFallbackBinDirs(osHome, platform, nvmDirs)) appendIfExisting(dir)

  return {
    ...env,
    ...nodeRuntime.envOverrides,
    CI: 'true',
    ...(merged.length > 0 ? { PATH: merged.join(delimiter) } : {}),
  }
}
