import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import {
  exportRayHomeClone,
  importRayHomeClone,
  initRayHome,
  inspectRayHomeStatus,
  migrateDshHomeToRayHome,
  resolveRayHome,
} from '../src/ray-home.ts'
import { collectGrowthReport } from '../src/growth-report.ts'
import { collectVersionReport } from '../src/version-report.ts'
import { main } from '../src/index.ts'

const dirs: string[] = []

afterEach(async () => {
  while (dirs.length > 0) {
    await rm(dirs.pop()!, { recursive: true, force: true })
  }
})

describe('CLI Ray Home management, migration, and plaintext clone', () => {
  test('initializes Ray Home, safely migrates SQLite + vault + rsi-sources while leaving credentials in $DSH_HOME, and lets growth/version reports read Ray Home DBs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cli-ray-home-'))
    dirs.push(root)
    const dshHome = join(root, 'dsh')
    const rayHome = join(root, 'external-disk', 'ray')
    const profileDir = join(dshHome, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(join(dshHome, 'personal-memory'), { recursive: true })
    mkdirSync(join(dshHome, 'personal-wiki', 'vault'), { recursive: true })
    mkdirSync(join(dshHome, 'rsi-sources', 'demo'), { recursive: true })
    mkdirSync(join(dshHome, 'credentials-keychain'), { recursive: true })

    // Seed real SQLite ledger DB + wiki + source + credential file in $DSH_HOME
    const pmDbPath = join(dshHome, 'personal-memory', 'web.sqlite')
    const db = new DatabaseSync(pmDbPath)
    db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL);')
    db.prepare('INSERT INTO memories (id, content) VALUES (?, ?)').run('m1', '主人喜欢先看结论')
    db.close()

    const credDbPath = join(dshHome, 'credentials-keychain', 'ledger.sqlite')
    writeFileSync(credDbPath, 'secret-keychain-placeholder', 'utf8')
    writeFileSync(join(dshHome, 'personal-wiki', 'vault', 'note.md'), '# 主人笔记\n重要事实', 'utf8')
    writeFileSync(join(dshHome, 'rsi-sources', 'demo', 'index.ts'), 'export const demo = 1\n', 'utf8')

    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      dependencies: { '@dsh-ray/personal-memory': '0.2.4', '@dsh-ray/assistant-policy': '0.2.4' },
    }))
    writeFileSync(join(profileDir, 'cordis.patch.yml'), [
      '- id: dsh-ray-assistant-policy',
      '  name: "@dsh-ray/assistant-policy"',
      '  config:',
      '    toolDefaultEffect: deny',
      '- id: dsh-ray-personal-memory',
      '  name: "@dsh-ray/personal-memory"',
      '  config:',
      `    databasePath: ${pmDbPath}`,
      '- id: dsh-ray-credentials-keychain',
      '  name: "@dsh-ray/credentials-keychain"',
      '  config:',
      `    databasePath: ${credDbPath}`,
      '',
    ].join('\n'), 'utf8')

    expect(resolveRayHome({ dshHome, profile: 'web', env: { HOME: root } })).toBe(join(root, '.ray'))

    const migrated = migrateDshHomeToRayHome({ dshHome, rayHome, profile: 'web' })
    expect(migrated.ok).toBe(true)
    expect(migrated.profilesUpdated).toEqual(['web'])
    expect(migrated.migratedDatabases.some(d => d.plugin === 'personal-memory')).toBe(true)
    // Credentials must NEVER be moved to Ray Home clone/migration state
    expect(migrated.migratedDatabases.some(d => d.plugin.includes('credentials'))).toBe(false)

    const migratedDbPath = join(rayHome, 'state', 'personal-memory', 'web.sqlite')
    expect(existsSync(migratedDbPath)).toBe(true)
    const verifyDb = new DatabaseSync(migratedDbPath, { readOnly: true })
    const row = verifyDb.prepare('SELECT content FROM memories WHERE id = ?').get('m1') as { content: string }
    verifyDb.close()
    expect(row.content).toBe('主人喜欢先看结论')
    expect(readFileSync(join(rayHome, 'state', 'personal-wiki-vault', 'note.md'), 'utf8')).toContain('重要事实')
    expect(existsSync(join(rayHome, 'plugins', 'rsi-sources', 'demo', 'index.ts'))).toBe(true)

    const updatedPatch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(updatedPatch).toContain(`rayHome: ${rayHome}`)
    expect(updatedPatch).toContain(`databasePath: ${migratedDbPath}`)
    expect(updatedPatch).toContain(`databasePath: ${credDbPath}`)

    // CLI resolveRayHome now reads migrated rayHome from profile cordis.patch.yml
    expect(resolveRayHome({ dshHome, profile: 'web', env: { HOME: root } })).toBe(rayHome)

    // growth-report & version-report accept DBs residing in Ray Home without skipping as out-of-bounds
    const growth = await collectGrowthReport({ dshHome, profile: 'web', since: '7d' })
    expect(growth.diagnostics.some(d => d.includes('越界'))).toBe(false)
    const ver = await collectVersionReport({ dshHome, profile: 'web', runningVersion: '0.2.2' })
    expect((ver.diagnostics ?? []).some(d => d.includes('越界'))).toBe(false)

    // Export & import plaintext clone preserving rayId & memories while excluding secrets
    writeFileSync(join(rayHome, 'self', 'feishu.token'), 'should-not-copy', 'utf8')
    const cloneDir = join(root, 'usb-clone')
    const targetRayHome = join(root, 'machine-b', 'ray')
    const exported = exportRayHomeClone({ rayHome, outputDir: cloneDir })
    expect(exported.credentialsExcluded).toBe(true)
    expect(existsSync(join(cloneDir, 'self', 'feishu.token'))).toBe(false)

    const imported = importRayHomeClone({ sourceDir: cloneDir, rayHome: targetRayHome })
    expect(imported.rayId).toBe(exported.rayId)
    expect(existsSync(join(targetRayHome, 'state', 'personal-memory', 'web.sqlite'))).toBe(true)

    const status = inspectRayHomeStatus(targetRayHome)
    expect(status.exists).toBe(true)
    expect(status.autobiographyCount).toBeGreaterThanOrEqual(2)
  })

  test('routes dsh-ray home subcommands via CLI main()', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cli-ray-main-'))
    dirs.push(root)
    const rayHome = join(root, 'my-ray')
    initRayHome(rayHome)

    let out = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown) => {
      out += String(chunk)
      return true
    }) as typeof process.stdout.write
    try {
      const exitCode = await main(['home', 'status', '--ray-home', rayHome, '--json'], { HOME: root, DSH_HOME: join(root, 'dsh') })
      expect(exitCode).toBe(0)
      const parsed = JSON.parse(out) as { exists: boolean; rayHome: string; name: string }
      expect(parsed.exists).toBe(true)
      expect(parsed.rayHome).toBe(rayHome)
      expect(parsed.name).toBe('文鳐')
    } finally {
      process.stdout.write = origWrite
    }
  })
})
