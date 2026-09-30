import { execFileSync } from 'node:child_process'
import { copyFile, cp, mkdir, readdir, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Real committed public-generator inputs without depending on the checkout's
 * .git directory. Source-builder containers receive a Git archive, so their
 * tests must create their own Git evidence just like other source fixtures. */
export async function createSourceCreationFixture(sourceRoot: string, target: string): Promise<{ repository: string; baseCommit: string }> {
  await mkdir(target, { recursive: true })
  for (const path of ['scripts/create-plugin.mjs', 'LICENSE', 'plugins/README.md', 'package.json',
    'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json', '.npmrc']) {
    await mkdir(dirname(join(target, path)), { recursive: true })
    await copyFile(join(sourceRoot, path), join(target, path))
  }
  await cp(join(sourceRoot, 'templates/plugin'), join(target, 'templates/plugin'), { recursive: true })
  for (const directory of ['plugins', 'packages']) {
    for (const entry of await readdir(join(sourceRoot, directory), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const destination = join(target, directory, entry.name)
      await mkdir(destination, { recursive: true })
      await copyFile(join(sourceRoot, directory, entry.name, 'package.json'), join(destination, 'package.json'))
    }
  }
  const repository = await realpath(target)
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '--quiet', '--initial-branch=fixture')
  git('-c', 'user.name=Source Fixture', '-c', 'user.email=source-fixture@example.invalid', 'add', '--all')
  git('-c', 'user.name=Source Fixture', '-c', 'user.email=source-fixture@example.invalid', 'commit', '--quiet', '-m', 'frozen generator fixture')
  return { repository, baseCommit: git('rev-parse', 'HEAD') }
}
