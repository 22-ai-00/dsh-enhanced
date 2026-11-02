import { chmod, cp, link, lstat, readdir, rename, rm, symlink } from 'node:fs/promises'
import { chmodSync, cpSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { hashLinuxRuntimeTree, linuxRuntimeDigest } from '@dsh-enhanced/assistant-isolation'
import { inspectLinuxRsiNativeBaseAt, openLinuxRsiNativeRelocatedBase, openLinuxRsiNativeRelocatedBaseAt,
  relocateLinuxRsiNativeBase } from '../src/rsi-linux-native-relocation.js'
import { fixture, privateDirectory, PROFILE, readJson, removeFixtureDirectories, seal, write, writeReceipt } from './fixtures/linux-native-home-fixture.js'

const peer = vi.hoisted(() => ({ required: vi.fn() }))
vi.mock('node:module', async importOriginal => {
  const actual = await importOriginal<typeof import('node:module')>()
  return { ...actual, createRequire: (url: string) => {
    const original = actual.createRequire(url)
    const guard = (specifier: string): void => {
      if (specifier === '@dsh-enhanced/assistant-verifier/linux-behavior-runtime') {
        peer.required(); throw new Error('base relocation must not require the behavior peer')
      }
    }
    return Object.assign((specifier: string) => { guard(specifier); return original(specifier) }, original,
      { resolve: (specifier: string) => { guard(specifier); return original.resolve(specifier) } })
  } }
})
const linux = test.runIf(process.platform === 'linux')
afterEach(async () => { vi.restoreAllMocks(); peer.required.mockClear(); await removeFixtureDirectories() })
async function baseFixture() {
  const f = await fixture()
  for (const name of ['rsi-authorities', 'rsi-linux-repository-runtimes', 'rsi-linux-creation-builds']) await rm(join(f.sourceHome, name), { recursive: true })
  await privateDirectory(f.physicalHome)
  const authority = join(f.physicalHome, 'rsi-authorities')
  await privateDirectory(authority); await write(join(authority, 'do-not-touch'), 'existing owner bytes')
  await write(join(f.sourceHome, 'rsi-authorities'), 'uninspected source authority')
  return { ...f, authority }
}
const inputOf = (f: Awaited<ReturnType<typeof baseFixture>>) => ({ sourceHome: f.sourceHome, physicalHome: f.physicalHome,
  logicalHome: f.logicalHome, profile: PROFILE })

linux('relocates only base+release and never requires or touches owner families', async () => {
  const f = await baseFixture(), before = await hashLinuxRuntimeTree(f.sourceHome), authority = await hashLinuxRuntimeTree(f.authority)
  await privateDirectory(join(f.physicalHome, 'rsi-linux-runtimes'))
  await privateDirectory(join(f.physicalHome, 'rsi-release-builds'))
  const proof = await relocateLinuxRsiNativeBase(inputOf(f))
  expect(proof.purpose).toBe('pre-owner-base')
  expect(proof.elements.map(e => e.name)).toEqual(['runtime', 'release-toolchain', 'release-store', 'release-cache'])
  const base = await openLinuxRsiNativeRelocatedBase(proof)
  expect(base.runtime.runtime.root.path).toBe(join(f.logicalHome, 'rsi-linux-runtimes', PROFILE, 'runtime'))
  expect(base.release.runtimeDigest).toBe(linuxRuntimeDigest(base.runtime.runtime))
  expect(await hashLinuxRuntimeTree(f.sourceHome)).toBe(before)
  expect(await hashLinuxRuntimeTree(f.authority)).toBe(authority)
  for (const name of ['rsi-linux-repository-runtimes', 'rsi-linux-creation-builds']) await expect(lstat(join(f.physicalHome, name))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(peer.required).not.toHaveBeenCalled()
})

linux('sealed base opens after same-inode rename and rejects arbitrary proof rebinding or tampering', async () => {
  const f = await baseFixture(), proof = await relocateLinuxRsiNativeBase(inputOf(f))
  await rename(f.physicalHome, f.logicalHome)
  expect((await openLinuxRsiNativeRelocatedBaseAt(proof, f.logicalHome)).runtime.sourceCommit).toBe('1'.repeat(40))
  await expect(openLinuxRsiNativeRelocatedBaseAt(proof, join(f.sourceHome, 'foreign'))).rejects.toThrow('does not describe')
  const altered = structuredClone(proof); altered.elements[0]!.ino++
  await expect(openLinuxRsiNativeRelocatedBaseAt(altered, f.logicalHome)).rejects.toThrow('proof digest differs')
  const wrongPurpose = { ...proof, purpose: 'owner-family' } as unknown as typeof proof
  await expect(openLinuxRsiNativeRelocatedBaseAt(wrongPurpose, f.logicalHome)).rejects.toThrow('invalid base relocation proof')
})

linux('source inspection accepts stock Home permissions and same-inode moves, not copied runtime identities', async () => {
  const f = await baseFixture()
  await chmod(f.sourceHome, 0o755)
  const before = await inspectLinuxRsiNativeBaseAt({ logicalHome: f.sourceHome, physicalHome: f.sourceHome, profile: PROFILE })
  const moved = f.sourceHome + '-moved', copied = f.sourceHome + '-copy'
  try {
    await rename(f.sourceHome, moved)
    expect(await inspectLinuxRsiNativeBaseAt({ logicalHome: f.sourceHome, physicalHome: moved, profile: PROFILE })).toEqual(before)
    await cp(moved, copied, { recursive: true })
    await expect(inspectLinuxRsiNativeBaseAt({ logicalHome: f.sourceHome, physicalHome: copied, profile: PROFILE })).rejects.toThrow('source tree identity differs')
  } finally { await rm(moved, { recursive: true, force: true }); await rm(copied, { recursive: true, force: true }) }
})

linux.each(['bad-release-pin', 'bad-node-pin', 'commit', 'mode', 'hardlink', 'escape', 'absolute-link'] as const)('rejects %s before creating target resource families', async kind => {
  const f = await baseFixture(), path = join(f.sourceHome, 'rsi-release-builds', PROFILE, 'bootstrap.json')
  if (kind === 'bad-release-pin' || kind === 'commit') {
    const receipt = await readJson(path)
    if (kind === 'bad-release-pin') (receipt.releaseBuild as Record<string, { sha256: string }>).cacheRoot!.sha256 = '0'.repeat(64)
    else receipt.sourceCommit = '2'.repeat(40)
    await writeReceipt(path, seal(receipt))
  } else if (kind === 'bad-node-pin') {
    const runtimePath = join(f.sourceHome, 'rsi-linux-runtimes', PROFILE, 'bootstrap.json'), receipt = await readJson(runtimePath)
    const descriptor = receipt.runtime as { nodeSha256: string }; descriptor.nodeSha256 = '0'.repeat(64)
    await writeReceipt(runtimePath, seal(receipt))
  } else if (kind === 'mode') await chmod(join(f.trees.runtime, 'bin/node'), 0o777)
  else if (kind === 'hardlink') await link(join(f.trees.runtime, 'pnpm-lock.yaml'), join(f.trees.runtime, 'duplicate'))
  else if (kind === 'escape') await symlink('../../outside', join(f.trees.runtime, 'escaped'))
  else await symlink(join(f.trees.runtime, 'bin/node'), join(f.trees.runtime, 'absolute'))
  await expect(relocateLinuxRsiNativeBase(inputOf(f))).rejects.toThrow()
  await expect(lstat(join(f.physicalHome, 'rsi-linux-runtimes', PROFILE))).rejects.toMatchObject({ code: 'ENOENT' })
})

linux.each(['source-runtime', 'source-release', 'source-release-root-mode', 'source-release-root-identity', 'destination-runtime'] as const)('detects cross-tree %s changes during the copy', async kind => {
  const f = await baseFixture(), signal = new AbortController().signal
  const destinationReady = join(f.physicalHome, 'rsi-release-builds', PROFILE, 'cache', 'metadata/state.json')
  let changed = false
  vi.spyOn(signal, 'throwIfAborted').mockImplementation(() => {
    if (changed || !existsSync(destinationReady)) return
    changed = true
    if (kind === 'source-release-root-mode') { chmodSync(f.trees.release.toolchain, 0o755); return }
    if (kind === 'source-release-root-identity') {
      const backup = f.trees.release.toolchain + '-old'
      renameSync(f.trees.release.toolchain, backup); cpSync(backup, f.trees.release.toolchain, { recursive: true }); rmSync(backup, { recursive: true }); return
    }
    const path = kind === 'source-runtime' ? join(f.trees.runtime, 'node_modules/index.js')
      : kind === 'source-release' ? join(f.trees.release.toolchain, 'lib/bin/pnpm.cjs')
        : join(f.physicalHome, 'rsi-linux-runtimes', PROFILE, 'runtime', 'node_modules/index.js')
    chmodSync(path, 0o644); writeFileSync(path, 'mutated after earlier tree copy\n')
  })
  await expect(relocateLinuxRsiNativeBase({ ...inputOf(f), signal })).rejects.toThrow()
  expect(changed).toBe(true)
})

linux('refuses existing target resources without touching the authority tree', async () => {
  const f = await baseFixture(), before = await hashLinuxRuntimeTree(f.authority)
  await privateDirectory(join(f.physicalHome, 'rsi-linux-runtimes', PROFILE))
  await expect(relocateLinuxRsiNativeBase(inputOf(f))).rejects.toThrow('target already exists')
  expect(await hashLinuxRuntimeTree(f.authority)).toBe(before)
})

test('rejects overlapping inspection and relocation identities before filesystem work', async () => {
  await expect(inspectLinuxRsiNativeBaseAt({ logicalHome: '/home/unit', physicalHome: '/home/unit/copy', profile: 'unit' })).rejects.toThrow('invalid base inspection identity')
  await expect(relocateLinuxRsiNativeBase({ sourceHome: '/home/unit', physicalHome: '/home/unit/copy', logicalHome: '/home/live', profile: 'unit' })).rejects.toThrow('overlap')
})
test.runIf(process.platform !== 'linux')('resource entrypoints reject non-Linux hosts', async () => {
  await expect(relocateLinuxRsiNativeBase({ sourceHome: '/source-home', physicalHome: '/stage-home', logicalHome: '/logical-home', profile: 'unit' })).rejects.toThrow('requires Linux')
  await expect(inspectLinuxRsiNativeBaseAt({ logicalHome: '/source-home', physicalHome: '/source-home', profile: 'unit' })).rejects.toThrow('requires Linux')
})


test.each(['runtime-parent', 'release-parent', 'new-home-ancestor'] as const)('destination ancestor refuses %s without outside writes', async kind => {
  const f = await baseFixture(), outside = join(dirname(f.sourceHome), 'outside')
  await privateDirectory(outside); await write(join(outside, 'existing'), 'untouched outside bytes')
  await chmod(outside, 0o750)
  const input = inputOf(f)
  if (kind === 'new-home-ancestor') {
    await privateDirectory(join(outside, 'nested'))
    await rm(f.physicalHome, { recursive: true })
    const alias = f.physicalHome + '-alias'
    await symlink(outside, alias)
    input.physicalHome = join(alias, 'nested', 'fresh-home')
  } else await symlink(outside, join(f.physicalHome, kind === 'runtime-parent' ? 'rsi-linux-runtimes' : 'rsi-release-builds'))
  const observe = async () => ({ entries: await readdir(outside), mode: (await lstat(outside)).mode,
    tree: await hashLinuxRuntimeTree(outside) })
  const before = await observe()
  let error: unknown
  try { await relocateLinuxRsiNativeBase(input) } catch (value) { error = value }
  const after = await observe()
  console.info('destination ancestor evidence', JSON.stringify({ kind, before, after, error: String(error) }))
  expect(after).toEqual(before)
  expect(String(error)).toContain('unsafe base destination parent')
  if (kind !== 'new-home-ancestor') for (const parent of ['rsi-linux-runtimes', 'rsi-release-builds']) {
    await expect(lstat(join(f.physicalHome, parent, PROFILE))).rejects.toMatchObject({ code: 'ENOENT' })
  }
})
