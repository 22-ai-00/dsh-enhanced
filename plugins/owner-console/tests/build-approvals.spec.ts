import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { assertBuildName, persistAllowedBuilds } from '../src/build-approvals.ts'

const directories: string[] = []
async function profile(workspace?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'owner-console-approvals-'))
  directories.push(dir)
  if (workspace !== undefined) await writeFile(join(dir, 'pnpm-workspace.yaml'), workspace)
  return dir
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('owner console profile build approvals', () => {
  it('creates the workspace policy with only the confirmed names', async () => {
    const dir = await profile()
    await persistAllowedBuilds(dir, ['protobufjs@7.6.6'])
    expect(parse(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8')))
      .toEqual({ allowBuilds: { 'protobufjs@7.6.6': true } })
  })

  it('keeps existing policy and decisions while adding confirmed names', async () => {
    const dir = await profile('packages:\n  - .\nallowBuilds:\n  esbuild: false\n')
    await persistAllowedBuilds(dir, ['protobufjs@7.6.6', 'protobufjs@7.6.6', '@scope/native'])
    expect(parse(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8'))).toEqual({
      packages: ['.'],
      allowBuilds: { esbuild: false, 'protobufjs@7.6.6': true, '@scope/native': true },
    })
  })

  it('refuses names or documents the Host would not accept, without writing', async () => {
    const dir = await profile('packages:\n  - .\n')
    for (const name of ['', 'pkg*', 'pkg\n2', 'x'.repeat(201), 'a b']) {
      await expect(persistAllowedBuilds(dir, [name])).rejects.toThrow()
    }
    await expect(persistAllowedBuilds(dir, Array.from({ length: 65 }, (_value, index) => `pkg${String(index)}`)))
      .rejects.toThrow()
    expect(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe('packages:\n  - .\n')
    const scalar = await profile('allowBuilds: true\n')
    await expect(persistAllowedBuilds(scalar, ['esbuild'])).rejects.toThrow('allowBuilds 必须是 YAML 映射')
    expect(() => { assertBuildName('esbuild') }).not.toThrow()
  })
})
