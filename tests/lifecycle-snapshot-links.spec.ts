import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { lifecycleProfileTest } from '../scripts/install/lifecycle-profile.mjs'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lifecycle-snapshot-links-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const original = join(root, 'home')
  const transaction = join(root, 'home.dsh-enhanced-transaction')
  await mkdir(original, { mode: 0o700 })
  await mkdir(join(transaction, 'staged-home'), { recursive: true, mode: 0o700 })
  const descriptor = await open(root, constants.O_RDONLY | constants.O_DIRECTORY)
  cleanups.push(() => descriptor.close())
  const stage = join(`/proc/self/fd/${descriptor.fd}`, 'home.dsh-enhanced-transaction', 'staged-home')
  return { root, original, stage }
}

describe.skipIf(process.platform !== 'linux')('lifecycle snapshot links through a directory descriptor', () => {
  test('accepts staged relative and absolute logical links with targets in the staged tree', async () => {
    const { original, stage } = await fixture()
    await mkdir(join(stage, 'node_modules'))
    await writeFile(join(stage, 'target'), 'staged', { mode: 0o600 })
    await symlink('../target', join(stage, 'node_modules', 'relative'))
    await symlink(join(original, 'target'), join(stage, 'node_modules', 'absolute'))

    await expect(lifecycleProfileTest.assertSnapshotTreeSafe(stage, original, false, new Map())).resolves.toBeInstanceOf(Map)
  })

  test('rejects a missing staged target even when the original home has that target', async () => {
    const { original, stage } = await fixture()
    await mkdir(join(original, 'node_modules'))
    await mkdir(join(stage, 'node_modules'))
    await writeFile(join(original, 'target'), 'old', { mode: 0o600 })
    await symlink('../target', join(original, 'node_modules', 'relative'))
    await symlink('../target', join(stage, 'node_modules', 'relative'))
    const allowed = await lifecycleProfileTest.assertSnapshotTreeSafe(original)

    await expect(lifecycleProfileTest.assertSnapshotTreeSafe(stage, original, false, allowed))
      .rejects.toThrow('新增或已改变的 node_modules 外链/悬空链接')
  })

  test('resolves a staged .bin link through an unchanged relative package link outside logical Home', async () => {
    const { root, original, stage } = await fixture()
    const nested = 'profiles/web/node_modules'
    const packageName = '@dsh-enhanced/plugin-control-plane'
    const packageTarget = '../../../../../work/github/dsh-enhanced/plugins/plugin-control-plane'
    const binary = '../@dsh-enhanced/plugin-control-plane/bin/tool.js'
    const external = join(root, 'work/github/dsh-enhanced/plugins/plugin-control-plane/bin/tool.js')
    await mkdir(join(root, 'work/github/dsh-enhanced/plugins/plugin-control-plane/bin'), { recursive: true, mode: 0o700 })
    await writeFile(external, 'export {}', { mode: 0o600 })
    for (const home of [original, stage]) {
      await mkdir(join(home, nested, '@dsh-enhanced'), { recursive: true, mode: 0o700 })
      await mkdir(join(home, nested, '.bin'), { mode: 0o700 })
      await symlink(packageTarget, join(home, nested, packageName))
      await symlink(binary, join(home, nested, '.bin/tool'))
    }
    const allowed = await lifecycleProfileTest.assertSnapshotTreeSafe(original)
    expect(allowed.get(`${nested}/.bin/tool`)?.target).toBe(external)
    await expect(lifecycleProfileTest.assertSnapshotTreeSafe(stage, original, false, allowed)).resolves.toBeInstanceOf(Map)

    await symlink(binary, join(stage, nested, '.bin/new'))
    await expect(lifecycleProfileTest.assertSnapshotTreeSafe(stage, original, false, allowed))
      .rejects.toThrow('新增或已改变的 node_modules 外链/悬空链接')
    await rm(join(stage, nested, '.bin/new'))
    await rm(join(stage, nested, packageName))
    await symlink('../../../../../work/github/dsh-enhanced/plugins/./plugin-control-plane', join(stage, nested, packageName))
    await expect(lifecycleProfileTest.assertSnapshotTreeSafe(stage, original, false, allowed))
      .rejects.toThrow('新增或已改变的 node_modules 外链/悬空链接')
    await rm(join(stage, nested, packageName))
    await mkdir(join(root, 'work/github/dsh-enhanced/plugins/other-plugin/bin'), { recursive: true, mode: 0o700 })
    await writeFile(join(root, 'work/github/dsh-enhanced/plugins/other-plugin/bin/tool.js'), 'export {}', { mode: 0o600 })
    await symlink('../../../../../work/github/dsh-enhanced/plugins/other-plugin', join(stage, nested, packageName))
    await expect(lifecycleProfileTest.assertSnapshotTreeSafe(stage, original, false, allowed))
      .rejects.toThrow('新增或已改变的 node_modules 外链/悬空链接')
  })

  test('rejects a missing staged binary through an unchanged internal package link', async () => {
    const { original, stage } = await fixture()
    for (const home of [original, stage]) {
      await mkdir(join(home, 'node_modules/@dsh-enhanced'), { recursive: true, mode: 0o700 })
      await mkdir(join(home, 'node_modules/.bin'), { mode: 0o700 })
      await mkdir(join(home, 'packages/tool/bin'), { recursive: true, mode: 0o700 })
      await symlink('../../packages/tool', join(home, 'node_modules/@dsh-enhanced/tool'))
      await symlink('../@dsh-enhanced/tool/bin/tool.js', join(home, 'node_modules/.bin/tool'))
    }
    await writeFile(join(original, 'packages/tool/bin/tool.js'), 'old', { mode: 0o600 })
    const allowed = await lifecycleProfileTest.assertSnapshotTreeSafe(original)
    await expect(lifecycleProfileTest.assertSnapshotTreeSafe(stage, original, false, allowed))
      .rejects.toThrow('新增或已改变的 node_modules 外链/悬空链接')
  })

  test('keeps absolute logical Home links staged and rejects a multi-hop escape', async () => {
    const { root, original, stage } = await fixture()
    await mkdir(join(stage, 'node_modules'))
    const outside = join(root, 'outside')
    const sibling = join(root, 'home-sibling')
    await writeFile(outside, 'outside', { mode: 0o600 })
    await writeFile(sibling, 'sibling', { mode: 0o600 })
    await symlink(outside, join(stage, 'node_modules/external'))
    await symlink(join(original, 'node_modules/external'), join(stage, 'node_modules/via-absolute'))
    await symlink(sibling, join(stage, 'node_modules/sibling'))
    const observed = await lifecycleProfileTest.assertSnapshotTreeSafe(stage, original)
    expect(observed.get('node_modules/via-absolute')?.target).toBe(outside)
    expect(observed.get('node_modules/sibling')?.target).toBe(sibling)
    await expect(lifecycleProfileTest.assertSnapshotTreeSafe(stage, original, false, new Map()))
      .rejects.toThrow('新增或已改变的 node_modules 外链/悬空链接')
  })

  test('rejects new or changed external package links while retaining the original external target', async () => {
    const { root, original, stage } = await fixture()
    await mkdir(join(original, 'node_modules'))
    await mkdir(join(stage, 'node_modules'))
    const outside = join(root, 'outside')
    const changedOutside = join(root, 'changed-outside')
    await writeFile(outside, 'outside', { mode: 0o600 })
    await writeFile(changedOutside, 'changed', { mode: 0o600 })
    await symlink(outside, join(original, 'node_modules', 'known'))
    const allowed = await lifecycleProfileTest.assertSnapshotTreeSafe(original)
    await symlink(outside, join(stage, 'node_modules', 'known'))
    await expect(lifecycleProfileTest.assertSnapshotTreeSafe(stage, original, false, allowed)).resolves.toBeInstanceOf(Map)

    await symlink(outside, join(stage, 'node_modules', 'new'))
    await expect(lifecycleProfileTest.assertSnapshotTreeSafe(stage, original, false, allowed))
      .rejects.toThrow('新增或已改变的 node_modules 外链/悬空链接')
    await rm(join(stage, 'node_modules', 'new'))
    await rm(join(stage, 'node_modules', 'known'))
    await symlink(changedOutside, join(stage, 'node_modules', 'known'))
    await expect(lifecycleProfileTest.assertSnapshotTreeSafe(stage, original, false, allowed))
      .rejects.toThrow('新增或已改变的 node_modules 外链/悬空链接')
  })

  test('retains an unchanged dangling package link but rejects a non-package external link', async () => {
    const { root, original, stage } = await fixture()
    await mkdir(join(original, 'node_modules'))
    await mkdir(join(stage, 'node_modules'))
    await symlink('../missing', join(original, 'node_modules', 'optional'))
    await symlink('../missing', join(stage, 'node_modules', 'optional'))
    const allowed = await lifecycleProfileTest.assertSnapshotTreeSafe(original)
    await expect(lifecycleProfileTest.assertSnapshotTreeSafe(stage, original, false, allowed)).resolves.toBeInstanceOf(Map)

    await writeFile(join(root, 'outside'), 'outside', { mode: 0o600 })
    await symlink(join(root, 'outside'), join(stage, 'unmanaged'))
    await expect(lifecycleProfileTest.assertSnapshotTreeSafe(stage, original, false, allowed))
      .rejects.toThrow('DSH_HOME 包含指向外部的符号链接')
  })

  test('rejects cycles and chains longer than 40 hops before a dangling whitelist can apply', async () => {
    const { original, stage } = await fixture()
    await mkdir(join(stage, 'node_modules'))
    await symlink('second', join(stage, 'node_modules/first'))
    await symlink('first', join(stage, 'node_modules/second'))
    const dangling = { linkText: 'second', target: undefined, targetIdentity: undefined }
    await expect(lifecycleProfileTest.assertSnapshotTreeSafe(stage, original, false,
      new Map([['node_modules/first', dangling], ['node_modules/second', { ...dangling, linkText: 'first' }]])))
      .rejects.toThrow('不可安全解析的符号链接')
    await rm(join(stage, 'node_modules/first'))
    await rm(join(stage, 'node_modules/second'))
    for (let index = 0; index <= 40; index += 1) {
      await symlink(`link-${index + 1}`, join(stage, 'node_modules', `link-${index}`))
    }
    await writeFile(join(stage, 'node_modules/link-41'), 'target', { mode: 0o600 })
    await expect(lifecycleProfileTest.assertSnapshotTreeSafe(stage, original, false, new Map()))
      .rejects.toThrow('不可安全解析的符号链接')
  })
})
