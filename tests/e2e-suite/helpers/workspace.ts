import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

export interface TempWorkspace {
  readonly root: string
  readonly dshHome: string
  readonly workspace: string
  readonly stateDir: string
  sqlitePath(name: string): string
  cleanup(): Promise<void>
}

export async function resolveTmpBase(): Promise<string> {
  const hasData00 = existsSync('/data00')
  const configured = process.env.TMPDIR
  if (configured !== undefined && configured.trim() !== '') {
    const resolved = resolve(configured)
    if (hasData00 && (resolved === '/tmp' || resolved.startsWith('/tmp/'))) {
      throw new Error('resolveTmpBase: TMPDIR must not point to /tmp when /data00 exists')
    }
    await mkdir(resolved, { recursive: true, mode: 0o700 })
    const real = await realpath(resolved)
    if (hasData00 && (real === '/tmp' || real.startsWith('/tmp/'))) {
      throw new Error('resolveTmpBase: TMPDIR must not point to /tmp when /data00 exists')
    }
    return real
  }
  if (hasData00) {
    const userHomeOnData00 = join('/data00/home', userInfo().username)
    if (existsSync(userHomeOnData00)) {
      const fallback = join(userHomeOnData00, 't')
      await mkdir(fallback, { recursive: true, mode: 0o700 })
      return realpath(fallback)
    }
    throw new Error('resolveTmpBase: TMPDIR is required when /data00 exists')
  }
  const fallback = tmpdir()
  await mkdir(fallback, { recursive: true, mode: 0o700 })
  return realpath(fallback)
}

export function createWorkspaceTracker() {
  const tracked: TempWorkspace[] = []

  return {
    async create(prefix = 'dsh-e2e-'): Promise<TempWorkspace> {
      const base = await resolveTmpBase()
      const root = await realpath(await mkdtemp(join(base, prefix)))
      const dshHome = join(root, 'dsh-home')
      const workspace = join(root, 'workspace')
      const stateDir = join(root, 'state')
      await Promise.all([
        mkdir(dshHome, { recursive: true, mode: 0o700 }),
        mkdir(workspace, { recursive: true, mode: 0o700 }),
        mkdir(stateDir, { recursive: true, mode: 0o700 }),
      ])

      const handle: TempWorkspace = {
        root,
        dshHome,
        workspace,
        stateDir,
        sqlitePath(name: string): string {
          const filename = name.endsWith('.sqlite') ? name : `${name}.sqlite`
          return join(stateDir, filename)
        },
        async cleanup(): Promise<void> {
          await rm(root, { recursive: true, force: true })
        },
      }
      tracked.push(handle)
      return handle
    },

    async cleanupAll(): Promise<void> {
      const items = tracked.splice(0)
      await Promise.all(items.map(item => item.cleanup()))
    },
  }
}

export async function createIsolatedEnv(
  workspace: TempWorkspace,
  overrides: Record<string, string | undefined> = {},
): Promise<NodeJS.ProcessEnv> {
  const tmpBase = await resolveTmpBase()
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: workspace.root,
    TMPDIR: tmpBase,
    DSH_HOME: workspace.dshHome,
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key]
    } else {
      env[key] = value
    }
  }
  return env
}
