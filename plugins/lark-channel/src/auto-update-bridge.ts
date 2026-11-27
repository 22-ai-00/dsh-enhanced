import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const requireFromHere = createRequire(import.meta.url)

export interface CliAutoUpdateModule {
  readonly launchUnattendedAutoUpgrade: (options: {
    dshHome: string
    profile?: string
    env?: Readonly<Record<string, string | undefined>>
    notify?: {
      channel: string
      account: string
      chatId?: string
      conversation?: Readonly<{ kind?: string; chat: string }>
      principal?: Readonly<Record<string, unknown>> | string
      ownerPrincipal?: string
    }
  }) => Promise<{
    ok: boolean
    state: 'upgraded'
    started: boolean
    alreadyCurrent?: boolean
    alreadyRunning?: boolean
    background?: boolean
    fromVersion?: string
    targetVersion?: string
    toNpm?: boolean
    launcher?: 'systemd-run' | 'detached'
    unitName?: string
    pid?: number
    runId?: string
    message: string
    error?: string
  }>
  readonly inspectPendingAutoUpdateNotification: (dshHome: string) => Promise<{
    ready: boolean
    status?: 'succeeded' | 'failed'
    notify: {
      runId: string
      channel?: string
      account?: string
      chatId?: string
      conversation?: Readonly<{ kind?: string; chat: string }>
    }
    message?: string
  } | undefined>
  readonly clearAutoUpdateNotifyMarker: (dshHome: string, expectedRunId?: string) => Promise<boolean>
}

function isCliAutoUpdateModule(value: unknown): value is CliAutoUpdateModule {
  if (typeof value !== 'object' || value === null) return false
  const rec = value as Record<string, unknown>
  return typeof rec.launchUnattendedAutoUpgrade === 'function'
    && typeof rec.inspectPendingAutoUpdateNotification === 'function'
    && typeof rec.clearAutoUpdateNotifyMarker === 'function'
}

function verifyPackageRootEntry(entryPath: string): boolean {
  try {
    const pkgPath = resolve(dirname(realpathSync(entryPath)), '..', 'package.json')
    if (!existsSync(pkgPath)) return false
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown }
    return parsed.name === '@dsh-ray/cli'
  } catch {
    return false
  }
}

function resolveCandidateCliEntries(env: Readonly<Record<string, string | undefined>>): string[] {
  const candidates: string[] = []
  const add = (p: string | undefined) => {
    if (p && existsSync(p) && !candidates.includes(p)) candidates.push(p)
  }

  try {
    add(requireFromHere.resolve('@dsh-ray/cli'))
  } catch { /* optional peer not in local node_modules */ }

  const home = env.HOME || homedir()
  const pathDirs = [
    ...(env.PATH ?? '').split(delimiter).filter(Boolean),
    join(home, '.npm-global', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.local', 'share', 'pnpm'),
    ...(process.platform === 'darwin' ? [join(home, 'Library', 'pnpm'), '/opt/homebrew/bin'] : []),
    '/usr/local/bin',
  ]
  for (const dir of pathDirs) {
    const bin = join(dir, 'dsh-ray')
    if (!existsSync(bin)) continue
    try {
      const realBin = realpathSync(bin)
      const pkgRoot = resolve(dirname(realBin), '..')
      const pkgFile = join(pkgRoot, 'package.json')
      if (existsSync(pkgFile)) {
        const parsed = JSON.parse(readFileSync(pkgFile, 'utf8')) as { name?: unknown }
        if (parsed.name === '@dsh-ray/cli') add(join(pkgRoot, 'lib', 'index.js'))
      }
    } catch { /* ignore invalid binary link */ }
  }

  const here = dirname(fileURLToPath(import.meta.url))
  const monorepoSibling = resolve(here, '..', '..', '..', 'packages', 'cli', 'lib', 'index.js')
  if (existsSync(monorepoSibling) && verifyPackageRootEntry(monorepoSibling)) {
    add(monorepoSibling)
  }

  return candidates
}

/**
 * Dynamically resolve `@dsh-ray/cli`'s shared auto-update helper without introducing a build-time
 * lockfile dependency, preferring installed global CLI binaries and monorepo workspace builds.
 */
export async function loadCliAutoUpdateModule(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<CliAutoUpdateModule | undefined> {
  for (const entryPath of resolveCandidateCliEntries(env)) {
    try {
      const url = pathToFileURL(entryPath).href
      const loaded: unknown = await import(url)
      if (isCliAutoUpdateModule(loaded)) return loaded
    } catch { /* try next candidate */ }
  }
  return undefined
}
