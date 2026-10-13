import { afterEach, expect, test } from 'vitest'
import { cp, lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareHostLocalSharedFallback, retireHostLocalSharedFallback,
  verifyRetiredHostLocalSharedFallback } from '../scripts/install/host-local-fallback.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-shared-fallback-')))
  roots.push(root)
  const originalHome = join(root, 'original'), stagedHome = join(root, 'staged')
  const oldHostRoot = join(root, 'old-host'), candidateHostRoot = join(root, 'candidate-host')
  const globalDshRoot = join(root, 'global', 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  await Promise.all([originalHome, oldHostRoot, candidateHostRoot, globalDshRoot].map(path => mkdir(path, { recursive: true })))
  await writeFile(join(globalDshRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' }))
  const shared = join(originalHome, 'profiles', 'node_modules')
  await mkdir(join(shared, '@deepseek-ai'), { recursive: true })
  const oldTarget = join(oldHostRoot, 'node_modules', '@deepseek-ai', 'cordis')
  const danglingGlobalTarget = join(globalDshRoot, 'node_modules', '@deepseek-ai', 'dsh-client-runtime')
  await symlink(oldTarget, join(shared, '@deepseek-ai', 'cordis'))
  await symlink(danglingGlobalTarget, join(shared, '@deepseek-ai', 'dsh-client-runtime'))
  await cp(originalHome, stagedHome, { recursive: true })
  return { root, originalHome, stagedHome, oldHostRoot, candidateHostRoot, globalDshRoot,
    profiles: [], oldTarget, danglingGlobalTarget }
}

async function withProfileFallback(input: Awaited<ReturnType<typeof fixture>>) {
  const name = '@dsh-enhanced/assistant-policy'
  const target = join(input.originalHome, 'profiles', 'assistant', 'node_modules', '.pnpm', 'node_modules', name)
  const projection = join(input.originalHome, 'profiles', 'assistant', '.dsh-module-fallback', 'node_modules', name)
  for (const home of [input.originalHome, input.stagedHome]) {
    const wrapperLink = join(home, 'profiles', 'assistant', '.dsh-module-fallback', 'node_modules', name)
    const activeLink = join(home, 'profiles', 'assistant', 'node_modules', name)
    await mkdir(join(wrapperLink, '..'), { recursive: true })
    await mkdir(join(activeLink, '..'), { recursive: true })
    await symlink(target, wrapperLink)
    await symlink(projection, activeLink)
  }
  return { ...input, profiles: ['assistant'], target, projection }
}

test('retires only a byte-for-byte copied, links-only old DSH shared cache, including dangling global links', async () => {
  const input = await fixture()
  const proof = await prepareHostLocalSharedFallback(input)
  expect(proof.entries).toHaveLength(3)
  await retireHostLocalSharedFallback({ proof, stagedHome: input.stagedHome })
  await verifyRetiredHostLocalSharedFallback({ proof, stagedHome: input.stagedHome })
  expect((await lstat(join(input.stagedHome, 'profiles', 'node_modules')).catch(() => undefined))).toBeUndefined()
  expect(await readlink(join(input.originalHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-client-runtime')))
    .toBe(input.danglingGlobalTarget)
})

test('rejects original or staged inventory drift before removing anything', async () => {
  const input = await fixture(), proof = await prepareHostLocalSharedFallback(input)
  const stagedLink = join(input.stagedHome, 'profiles', 'node_modules', '@deepseek-ai', 'cordis')
  await rm(stagedLink)
  await symlink(join(input.candidateHostRoot, 'node_modules', '@deepseek-ai', 'cordis'), stagedLink)
  await expect(retireHostLocalSharedFallback({ proof, stagedHome: input.stagedHome })).rejects.toThrow('staged shared fallback changed')
  await rm(stagedLink)
  await symlink(input.oldTarget, stagedLink)
  const originalLink = join(input.originalHome, 'profiles', 'node_modules', '@deepseek-ai', 'cordis')
  await rm(originalLink)
  await symlink(join(input.root, 'outside'), originalLink)
  await expect(retireHostLocalSharedFallback({ proof, stagedHome: input.stagedHome })).rejects.toThrow('untrusted shared fallback target')
  expect(await lstat(join(input.stagedHome, 'profiles', 'node_modules'))).toBeDefined()
})

test('rejects files and unknown link targets instead of deleting a custom directory', async () => {
  const input = await fixture()
  const shared = join(input.originalHome, 'profiles', 'node_modules')
  await writeFile(join(shared, 'custom.js'), 'data')
  await expect(prepareHostLocalSharedFallback(input)).rejects.toThrow('unexpected shared fallback entry')
  await rm(join(shared, 'custom.js'))
  await symlink(join(input.root, 'other', 'node_modules', 'custom'), join(shared, 'custom'))
  await expect(prepareHostLocalSharedFallback(input)).rejects.toThrow('untrusted shared fallback target')
})

test('requires an explicitly authenticated global DSH root for old global targets', async () => {
  const input = await fixture()
  await expect(prepareHostLocalSharedFallback({ ...input, globalDshRoot: undefined }))
    .rejects.toThrow('untrusted shared fallback target')
  const proof = await prepareHostLocalSharedFallback(input)
  await writeFile(join(input.globalDshRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.1' }))
  await expect(retireHostLocalSharedFallback({ proof, stagedHome: input.stagedHome }))
    .rejects.toThrow('unsupported global DSH identity')
})

test('retires exact profile projections and wrapper while retaining the original source', async () => {
  const input = await withProfileFallback(await fixture())
  const proof = await prepareHostLocalSharedFallback(input)
  expect(proof.profileCaches.assistant.projections).toHaveLength(1)
  await retireHostLocalSharedFallback({ proof, stagedHome: input.stagedHome })
  await verifyRetiredHostLocalSharedFallback({ proof, stagedHome: input.stagedHome })
  expect(await readlink(join(input.originalHome, 'profiles', 'assistant', 'node_modules', '@dsh-enhanced', 'assistant-policy')))
    .toBe(input.projection)
  expect(await lstat(join(input.stagedHome, 'profiles', 'assistant', '.dsh-module-fallback')).catch(() => undefined))
    .toBeUndefined()
})

test('rejects changed projection links and custom profile wrapper files', async () => {
  const input = await withProfileFallback(await fixture())
  const proof = await prepareHostLocalSharedFallback(input)
  const link = join(input.stagedHome, 'profiles', 'assistant', 'node_modules', '@dsh-enhanced', 'assistant-policy')
  await rm(link)
  await symlink(join(input.root, 'outside'), link)
  await expect(retireHostLocalSharedFallback({ proof, stagedHome: input.stagedHome }))
    .rejects.toThrow('staged profile fallback changed')
  await rm(link)
  await symlink(input.projection, link)
  const wrapper = join(input.originalHome, 'profiles', 'assistant', '.dsh-module-fallback')
  await writeFile(join(wrapper, 'custom.js'), 'data')
  await expect(retireHostLocalSharedFallback({ proof, stagedHome: input.stagedHome }))
    .rejects.toThrow('unexpected profile fallback wrapper')
})
