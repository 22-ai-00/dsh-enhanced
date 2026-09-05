import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baseline = '0.1.2-rc.1'

interface WorkspaceManifest {
  name: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

interface WorkspaceConfig {
  catalog?: Record<string, string>
  minimumReleaseAgeExclude?: string[]
}

async function workspaceManifests() {
  const paths = ['package.json']
  for (const directory of ['packages', 'plugins']) {
    const entries = await readdir(join(repoRoot, directory), { withFileTypes: true })
    paths.push(...entries
      .filter(entry => entry.isDirectory())
      .map(entry => join(directory, entry.name, 'package.json')))
  }
  return Promise.all(paths.map(async (path) => ({
    manifest: JSON.parse(await readFile(join(repoRoot, path), 'utf8')) as WorkspaceManifest,
    path,
  })))
}

async function pluginManifests() {
  const pluginsRoot = join(repoRoot, 'plugins')
  const entries = await readdir(pluginsRoot, { withFileTypes: true })
  return Promise.all(entries
    .filter(entry => entry.isDirectory())
    .map(async (entry) => {
      const path = join(pluginsRoot, entry.name, 'package.json')
      const manifest = JSON.parse(await readFile(path, 'utf8')) as {
        name: string
        peerDependencies?: Record<string, string>
        peerDependenciesMeta?: Record<string, { optional?: boolean }>
      }
      return { manifest, path }
    }))
}

describe('DSH compatibility baseline', () => {
  test('pins every cataloged DSH package to the verified host release', async () => {
    const workspace = await readFile(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
    const versions = [...workspace.matchAll(/^\s+'@deepseek-ai\/(dsh-[^']+)':\s+([^\s#]+)$/gm)]

    expect(versions.length).toBeGreaterThan(0)
    expect(versions.map(([, name, version]) => ({ name, version })))
      .toEqual(versions.map(([, name]) => ({ name, version: baseline })))
  })

  test('uses the workspace catalog for every direct DSH dependency', async () => {
    const dependencies = (await workspaceManifests()).flatMap(({ manifest, path }) =>
      (['dependencies', 'devDependencies'] as const).flatMap(section =>
        Object.entries(manifest[section] ?? {})
          .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
          .map(([name, specifier]) => ({ path, section, name, specifier }))))

    expect(dependencies.length).toBeGreaterThan(0)
    expect(dependencies.filter(({ specifier }) => specifier !== 'catalog:')).toEqual([])
  })

  test('exempts every cataloged DSH release from the minimum release age', async () => {
    const workspace = parse(await readFile(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')) as WorkspaceConfig
    const catalogEntries = Object.entries(workspace.catalog ?? {})
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
      .map(([name, version]) => `${name}@${version}`)
      .sort()
    const ageExcludes = (workspace.minimumReleaseAgeExclude ?? [])
      .filter(entry => entry.startsWith('@deepseek-ai/dsh-'))
      .sort()

    expect(catalogEntries.length).toBeGreaterThan(0)
    expect(ageExcludes).toEqual(catalogEntries)
  })

  test('does not resolve mixed DSH runtime releases in the workspace lockfile', async () => {
    const lockfile = await readFile(join(repoRoot, 'pnpm-lock.yaml'), 'utf8')
    const resolutions = [...lockfile.matchAll(/^  '(@deepseek-ai\/dsh-[^'@]+)@([^'(]+)(?:\([^']*)?':$/gm)]
      .map(([, name, version]) => ({ name, version }))

    expect(resolutions.length).toBeGreaterThan(0)
    expect(resolutions.filter(({ version }) => version !== baseline)).toEqual([])
  })

  test('does not advertise support below the verified baseline', async () => {
    const peers = (await pluginManifests()).flatMap(({ manifest, path }) =>
      Object.entries(manifest.peerDependencies ?? {})
        .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
        .map(([name, range]) => ({ package: manifest.name, path, name, range })))

    expect(peers.length).toBeGreaterThan(0)
    for (const peer of peers) {
      expect(peer, peer.path).toMatchObject({ range: `>=${baseline} <0.2.0` })
    }
  })

  test('marks every plugin peer optional so profile pnpm never installs a second host runtime', async () => {
    for (const { manifest, path } of await pluginManifests()) {
      for (const peerName of Object.keys(manifest.peerDependencies ?? {})) {
        expect(manifest.peerDependenciesMeta?.[peerName]?.optional, `${path}: ${peerName}`).toBe(true)
      }
    }
  })

  test('records the verified runtime baseline', async () => {
    const compatibility = await readFile(join(repoRoot, 'docs', 'compatibility.md'), 'utf8')

    expect(compatibility).toContain(`运行时与 npm 测试依赖：\`${baseline}\``)
  })
})
