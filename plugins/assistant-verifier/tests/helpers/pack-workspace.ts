import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, cp, lstat, mkdir, readFile, readdir, readlink, realpath, symlink } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

export type PackPackage = readonly [kind: 'packages' | 'plugins', slug: string]

async function linkInstalledDependencies(repository: string, destination: string, source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    // Executables and their virtual-store targets remain installed read inputs;
    // workspace packages resolve against private copies. Test caches are omitted.
    if (entry.name.startsWith('.') && !['.bin', '.pnpm'].includes(entry.name)) continue
    const original = join(source, entry.name), linked = join(target, entry.name)
    if (entry.isDirectory() && entry.name.startsWith('@')) {
      await linkInstalledDependencies(repository, destination, original, linked)
    } else {
      const resolved = await realpath(original)
      const path = relative(repository, resolved)
      const workspace = path.split(sep).length === 2 && (path.startsWith(`packages${sep}`) || path.startsWith(`plugins${sep}`))
      await symlink(workspace ? join(destination, path) : resolved, linked, 'dir')
    }
  }
}

/** Keep workspace resolution and prepack intact, with every emitted file in a private tree. */
export async function copyPackWorkspace(repository: string, destination: string, targets: readonly PackPackage[]): Promise<void> {
  repository = await realpath(repository)
  await mkdir(destination)
  destination = await realpath(destination)
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'tsconfig.base.json']) {
    await copyFile(join(repository, name), join(destination, name))
  }
  for (const kind of ['packages', 'plugins'] as const) {
    for (const entry of await readdir(join(repository, kind), { withFileTypes: true })) {
      if (!entry.isDirectory() || !existsSync(join(repository, kind, entry.name, 'package.json'))) continue
      const source = join(repository, kind, entry.name)
      const target = join(destination, kind, entry.name)
      const rebuild = targets.some(([targetKind, slug]) => targetKind === kind && slug === entry.name)
      await mkdir(target, { recursive: true })
      if (rebuild) {
        await cp(source, target, {
          recursive: true,
          filter: path => !['lib', 'node_modules', 'tests'].includes(relative(source, path).split(sep)[0]!),
        })
      } else {
        await copyFile(join(source, 'package.json'), join(target, 'package.json'))
        // Already built dependencies are read-only type inputs, never outputs of this fixture.
        if (existsSync(join(source, 'lib'))) await cp(join(source, 'lib'), join(target, 'lib'), { recursive: true })
      }
      await linkInstalledDependencies(repository, destination, join(source, 'node_modules'), join(target, 'node_modules'))
    }
  }
  await linkInstalledDependencies(repository, destination, join(repository, 'node_modules'), join(destination, 'node_modules'))
}

/** Detect equal-byte rewrites as well as content changes in the shared package outputs. */
export async function snapshotPackageLibraries(repository: string, packages: readonly PackPackage[]): Promise<unknown[]> {
  const entries: unknown[] = []
  async function visit(path: string): Promise<void> {
    const stat = await lstat(path, { bigint: true })
    entries.push({
      path: relative(repository, path), dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
      size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
      ...(stat.isFile() ? { sha256: createHash('sha256').update(await readFile(path)).digest('hex') } : {}),
      ...(stat.isSymbolicLink() ? { link: await readlink(path) } : {}),
    })
    if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name))
  }
  for (const [kind, slug] of packages) await visit(join(repository, kind, slug, 'lib'))
  return entries
}
