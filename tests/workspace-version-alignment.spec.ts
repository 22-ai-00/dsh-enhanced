import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The Linux native runtime freezes every workspace manifest and rejects any
// whose version differs from the root (owner program updates fail closed).
describe('workspace version alignment', () => {
  test('every plugin and package manifest carries the root version', () => {
    const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }
    const misaligned: string[] = []
    for (const directory of ['plugins', 'packages']) {
      for (const name of readdirSync(join(repoRoot, directory))) {
        const path = join(repoRoot, directory, name, 'package.json')
        if (!existsSync(path)) continue
        const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: string }
        if (manifest.version !== root.version) misaligned.push(`${directory}/${name}@${manifest.version}`)
        const versionPath = join(repoRoot, directory, name, 'src', 'version.ts')
        if (existsSync(versionPath) && !readFileSync(versionPath, 'utf8').includes(`'${root.version}'`)) {
          misaligned.push(`${directory}/${name}/src/version.ts`)
        }
      }
    }
    expect(misaligned).toEqual([])
  })
})
