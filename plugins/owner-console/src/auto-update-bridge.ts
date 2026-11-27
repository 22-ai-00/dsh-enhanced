import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const requireFromHere = createRequire(import.meta.url)

export interface CliAutoUpdateNotifyTarget {
  readonly channel: string
  readonly account: string
  readonly chatId?: string
  readonly conversation?: Readonly<{ kind?: string; chat: string }>
  readonly principal?: Readonly<Record<string, unknown>> | string
  readonly ownerPrincipal?: string
}

export interface CliLaunchAutoUpdateOptions {
  readonly dshHome: string
  readonly profile?: string
  readonly platform?: NodeJS.Platform
  readonly osHome?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly notify?: CliAutoUpdateNotifyTarget
}

export interface CliLaunchAutoUpdateResult {
  readonly ok: boolean
  readonly state: 'upgraded'
  readonly started: boolean
  readonly alreadyCurrent?: boolean
  readonly alreadyRunning?: boolean
  readonly background?: boolean
  readonly fromVersion?: string
  readonly targetVersion?: string
  readonly toNpm?: boolean
  readonly launcher?: 'systemd-run' | 'detached'
  readonly unitName?: string
  readonly pid?: number
  readonly runId?: string
  readonly message: string
  readonly error?: string
}

export interface CliAutoUpdateModule {
  readonly launchUnattendedAutoUpgrade: (
    options: CliLaunchAutoUpdateOptions,
  ) => Promise<CliLaunchAutoUpdateResult>
}

function isCliAutoUpdateModule(value: unknown): value is CliAutoUpdateModule {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>).launchUnattendedAutoUpgrade === 'function'
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

/** Dynamically load `@dsh-ray/cli` so `owner-console` and `lark-channel` share ONE auto-update implementation. */
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
