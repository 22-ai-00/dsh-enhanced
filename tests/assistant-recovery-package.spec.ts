import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, test } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const recoveryRoot = join(repoRoot, 'plugins', 'assistant-recovery')
const temporaryRoots: string[] = []
const lastReleaseWithoutRecoveryHostSeams = '0.1.7'
const requiredHostPeers = [
  '@dsh-enhanced/assistant-automations',
  '@dsh-enhanced/assistant-delivery',
  '@dsh-enhanced/assistant-evaluation',
  '@dsh-enhanced/assistant-evolution',
  '@dsh-enhanced/assistant-health',
  '@dsh-enhanced/preference-learning',
] as const

function tarTextEntries(compressed: Buffer): ReadonlyMap<string, string> {
  const archive = gunzipSync(compressed)
  const entries = new Map<string, string>()
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const field = (start: number, end: number): string => {
      const bytes = header.subarray(start, end)
      const terminator = bytes.indexOf(0)
      return bytes.subarray(0, terminator === -1 ? bytes.length : terminator).toString('utf8')
    }
    const name = field(0, 100)
    const prefix = field(345, 500)
    const path = prefix === '' ? name : `${prefix}/${name}`
    const size = Number.parseInt(field(124, 136).trim() || '0', 8)
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`invalid tar entry size for ${path}`)
    const contentStart = offset + 512
    if (path === 'package/package.json' || path === 'package/README.md') {
      entries.set(path, archive.subarray(contentStart, contentStart + size).toString('utf8'))
    }
    offset = contentStart + Math.ceil(size / 512) * 512
  }
  return entries
}

function stableVersion(value: string): readonly [number, number, number] {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/u)
  if (match === null) throw new Error(`invalid stable version: ${value}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareStableVersions(left: string, right: string): number {
  const a = stableVersion(left)
  const b = stableVersion(right)
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1
  }
  return 0
}

function satisfiesSimpleRange(version: string, range: string): boolean {
  return range.split(/\s+/u).every(clause => {
    const match = clause.match(/^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/u)
    if (match === null) throw new Error(`unsupported test range: ${range}`)
    const comparison = compareStableVersions(version, match[2]!)
    switch (match[1] ?? '=') {
      case '>': return comparison > 0
      case '>=': return comparison >= 0
      case '<': return comparison < 0
      case '<=': return comparison <= 0
      default: return comparison === 0
    }
  })
}

function nextPatch(version: string): string {
  const [major, minor, patch] = stableVersion(version)
  return `${major}.${minor}.${patch + 1}`
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('assistant-recovery packed contract', () => {
  test('packed manifest rejects the published peer set that lacks required Host seams', async () => {
    const packRoot = await mkdtemp(join(tmpdir(), 'dsh-enhanced-recovery-pack-'))
    temporaryRoots.push(packRoot)
    const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [
      '--dir', recoveryRoot, 'pack', '--pack-destination', packRoot, '--json',
    ], { cwd: repoRoot, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    const tarballs = (await readdir(packRoot)).filter(path => path.endsWith('.tgz'))
    expect(tarballs).toHaveLength(1)

    const entries = tarTextEntries(await readFile(join(packRoot, tarballs[0]!)))
    const packed = JSON.parse(entries.get('package/package.json') ?? '') as {
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
    const source = JSON.parse(await readFile(join(recoveryRoot, 'package.json'), 'utf8')) as {
      peerDependencies: Record<string, string>
    }
    for (const peer of requiredHostPeers) {
      const range = packed.peerDependencies?.[peer]
      expect(range, peer).toBe(source.peerDependencies[peer])
      expect(satisfiesSimpleRange(lastReleaseWithoutRecoveryHostSeams, range!), peer).toBe(false)
      expect(satisfiesSimpleRange(nextPatch(lastReleaseWithoutRecoveryHostSeams), range!), peer).toBe(true)
      expect(packed.peerDependenciesMeta?.[peer]?.optional, peer).toBe(true)
    }

    const packedReadme = entries.get('package/README.md') ?? ''
    expect(packedReadme).toContain('./scripts/install/install-local.sh --scenario supervised --lark configure')
  }, 30_000)
})
