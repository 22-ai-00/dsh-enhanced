import { execFileSync } from 'node:child_process'
import { link, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { assertManagedVersionPaths, managedPatchVersionFiles, verifyManagedPatchVersion } from '../src/source-versioning.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture(version = '1.2.3', name = 'helper') {
  const root = await mkdtemp(join(tmpdir(), 'source-versioning-')); roots.push(root)
  const repository = join(root, 'repo'); const plugin = join(repository, 'plugins', name); const source = join(plugin, 'src')
  await mkdir(source, { recursive: true })
  const manifest = { name: `@dsh-enhanced/${name}`, version, dsh: { bundle: { patch: './cordis.patch.yml' } }, scripts: { check: 'pnpm check' }, dependencies: { leftpad: '1.0.0' }, metadata: { alpha: 1, beta: 2 } }
  await writeFile(join(plugin, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(source, 'version.ts'), `export const version = '${version}'\n`)
  await writeFile(join(source, 'index.ts'), 'export const stable = true\n')
  const environment = { PATH: process.env.PATH, HOME: root }
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: repository, env: environment, encoding: 'utf8' }).trim()
  git('init', '-q'); git('add', '--all'); git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base')
  return { root, repository, plugin, source, name, environment, baseCommit: git('rev-parse', 'HEAD'), manifest }
}

function input(f: Awaited<ReturnType<typeof fixture>>, extra: Partial<Parameters<typeof managedPatchVersionFiles>[0]> = {}) {
  return { worktree: f.repository, baseCommit: f.baseCommit, name: f.name, environment: f.environment, ...extra }
}

async function writeExpected(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await managedPatchVersionFiles(input(f))
  for (const file of result.files) await writeFile(join(f.plugin, file.path), file.content)
  return result
}

test('derives the next stable patch only from tracked base blobs and returns Host-owned files', async () => {
  const f = await fixture()
  await writeFile(join(f.plugin, 'package.json'), '{"name":"attacker","version":"9.9.9"}\n')
  await writeFile(join(f.source, 'version.ts'), "export const version = '9.9.9'\n")
  const result = await managedPatchVersionFiles(input(f))
  expect(result).toMatchObject({ baseVersion: '1.2.3', version: '1.2.4' })
  expect(result.files).toEqual([
    expect.objectContaining({ path: 'package.json' }),
    { path: 'src/version.ts', content: "export const version = '1.2.4'\n" },
  ])
  expect(JSON.parse(result.files[0]!.content)).toMatchObject({ name: '@dsh-enhanced/helper', version: '1.2.4', scripts: { check: 'pnpm check' } })
})

test('accepts semantic manifest formatting changes only when every non-version field remains the base value', async () => {
  const f = await fixture(); const result = await writeExpected(f)
  const parsed = JSON.parse(result.files[0]!.content) as Record<string, unknown>
  await writeFile(join(f.plugin, 'package.json'), JSON.stringify({ dependencies: parsed.dependencies, scripts: parsed.scripts,
    metadata: { beta: 2, alpha: 1 }, dsh: parsed.dsh, version: parsed.version, name: parsed.name }))
  await expect(verifyManagedPatchVersion(input(f))).resolves.toEqual({ baseVersion: '1.2.3', version: '1.2.4' })
  type MutableManifest = { name: string; version: string; scripts: { check: string }; dependencies: { leftpad: string }; unreviewed?: boolean }
  for (const mutate of [
    (value: MutableManifest) => { value.dependencies.leftpad = '2.0.0' },
    (value: MutableManifest) => { value.scripts.check = 'attacker' },
    (value: MutableManifest) => { value.name = '@dsh-enhanced/other' },
    (value: MutableManifest) => { value.unreviewed = true },
  ]) {
    const changed = JSON.parse(result.files[0]!.content) as MutableManifest
    mutate(changed)
    await writeFile(join(f.plugin, 'package.json'), JSON.stringify(changed))
    await expect(verifyManagedPatchVersion(input(f))).rejects.toThrow(/differ from the base/u)
  }
})

test('rejects current runtime replacement, unsafe current files, and missing current files', async () => {
  const f = await fixture(); await writeExpected(f)
  await writeFile(join(f.source, 'version.ts'), "export const version = '1.2.4'\nexport const injected = true\n")
  await expect(verifyManagedPatchVersion(input(f))).rejects.toThrow(/differ from the base/u)
  await writeFile(join(f.source, 'version.ts'), "export const version = '1.2.4'\n")
  await unlink(join(f.source, 'version.ts')); await symlink(join(f.source, 'index.ts'), join(f.source, 'version.ts'))
  await expect(verifyManagedPatchVersion(input(f))).rejects.toThrow(/canonical|regular file/u)
  await unlink(join(f.source, 'version.ts')); await writeFile(join(f.source, 'version.ts'), "export const version = '1.2.4'\n")
  await link(join(f.source, 'version.ts'), join(f.source, 'version-copy.ts'))
  await expect(verifyManagedPatchVersion(input(f))).rejects.toThrow(/regular file/u)
  await unlink(join(f.source, 'version.ts'))
  await expect(verifyManagedPatchVersion(input(f))).rejects.toThrow()
})

test('rejects pre-release, overflow, protected, malformed base identities, and cancellation', async () => {
  const prerelease = await fixture('1.2.3-rc.1')
  await expect(managedPatchVersionFiles(input(prerelease))).rejects.toThrow(/stable x.y.z/u)
  const overflow = await fixture(`1.2.${Number.MAX_SAFE_INTEGER}`)
  await expect(managedPatchVersionFiles(input(overflow))).rejects.toThrow(/safe increment/u)
  const protectedPlugin = await fixture('1.2.3', 'assistant-policy')
  await expect(managedPatchVersionFiles(input(protectedPlugin))).rejects.toThrow(/protected safety root/u)
  const bad = await fixture(); const manifest = { ...bad.manifest, name: '@dsh-enhanced/other' }
  await writeFile(join(bad.plugin, 'package.json'), JSON.stringify(manifest));
  execFileSync('/usr/bin/git', ['add', '--all'], { cwd: bad.repository, env: bad.environment })
  execFileSync('/usr/bin/git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'bad'], { cwd: bad.repository, env: bad.environment })
  bad.baseCommit = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: bad.repository, env: bad.environment, encoding: 'utf8' }).trim()
  await expect(managedPatchVersionFiles(input(bad))).rejects.toThrow(/identity or bundle patch/u)
  const badRuntime = await fixture()
  await writeFile(join(badRuntime.source, 'version.ts'), "export const version = '1.2.3'\nexport const injected = true\n")
  execFileSync('/usr/bin/git', ['add', '--all'], { cwd: badRuntime.repository, env: badRuntime.environment })
  execFileSync('/usr/bin/git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'bad-runtime'], { cwd: badRuntime.repository, env: badRuntime.environment })
  badRuntime.baseCommit = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: badRuntime.repository, env: badRuntime.environment, encoding: 'utf8' }).trim()
  await expect(managedPatchVersionFiles(input(badRuntime))).rejects.toThrow(/canonical constant/u)
  const aborted = new AbortController(); aborted.abort(new Error('cancelled'))
  await expect(managedPatchVersionFiles(input(await fixture(), { signal: aborted.signal }))).rejects.toThrow('cancelled')
})

test('reserves version paths only after canonical path validation', () => {
  expect(() => assertManagedVersionPaths([{ path: 'package.json', content: '{}' }])).toThrow(/Host-managed/u)
  expect(() => assertManagedVersionPaths([{ path: 'src/version.ts', content: 'x' }])).toThrow(/Host-managed/u)
  expect(() => assertManagedVersionPaths([{ path: 'src/../version.ts', content: 'x' }])).toThrow(/escapes|canonical/u)
  expect(() => assertManagedVersionPaths([{ path: 'src/index.ts', content: 'x' }])).not.toThrow()
})
