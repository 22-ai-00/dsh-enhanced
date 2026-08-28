import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baseline = '0.1.0-rc.8'
const upstreamCommit = '141eb6fef83422698aef7a981029e843e8161534'

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
  test('pins every cataloged DSH package to the verified rc.8 release', async () => {
    const workspace = await readFile(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
    const versions = [...workspace.matchAll(/^\s+'@deepseek-ai\/(dsh-[^']+)':\s+([^\s#]+)$/gm)]

    expect(versions.length).toBeGreaterThan(0)
    expect(versions.map(([, name, version]) => ({ name, version })))
      .toEqual(versions.map(([, name]) => ({ name, version: baseline })))
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

  test('records the exact upstream source state used for verification', async () => {
    const compatibility = await readFile(join(repoRoot, 'docs', 'compatibility.md'), 'utf8')

    expect(compatibility).toContain(`运行时与 npm 测试依赖：\`${baseline}\``)
    expect(compatibility).toContain(`上游源码提交 \`${upstreamCommit}\``)
  })
})
