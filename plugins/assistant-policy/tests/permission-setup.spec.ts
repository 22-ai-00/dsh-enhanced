import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { isMap, isSeq, parseDocument, YAMLMap } from 'yaml'
import { parsePermissionSetupArgs, setPermissionDefault as setPermissionDefaultWithReader } from '../src/permission-setup.ts'
import type { PermissionSetupArgs } from '../src/permission-setup.ts'

const temporaryRoots: string[] = []

async function fixtureEffectiveConfig(home: string, profile: string, rowId: string): Promise<YAMLMap> {
  let config = parseDocument('presets:\n  read-only: { sandbox: read-only, approval: ask }\n').contents as YAMLMap
  for (const path of [join(home, 'cordis.patch.yml'), join(home, 'profiles', profile, 'cordis.patch.yml')]) {
    let source: string
    try { source = await readFile(path, 'utf8') } catch { continue }
    const sequence = parseDocument(source).contents
    if (!isSeq(sequence)) continue
    for (const row of sequence.items) {
      if (!isMap(row)) continue
      const mapping = row as YAMLMap
      if (mapping.get('id') !== rowId) continue
      const candidate = mapping.get('config', true)
      if (isMap(candidate)) config = candidate.clone() as YAMLMap
    }
  }
  return config
}

function setPermissionDefault(input: Pick<PermissionSetupArgs, 'dshHome' | 'profile' | 'preset'>) {
  return setPermissionDefaultWithReader(input, fixtureEffectiveConfig)
}

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-permission-setup-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('permission setup', () => {
  test('writes only the canonical explicit preset while preserving unrelated settings', async () => {
    const home = await temporaryHome()
    await writeFile(join(home, 'settings.yaml'), 'theme: dark\npermission:\n  defaultPreset: auto\n  extra: retain\n', 'utf8')

    await setPermissionDefault({ dshHome: home, preset: 'workspace-write' })

    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).toContain('theme: dark')
    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).toContain('defaultPreset: workspace-write')
    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).toContain('extra: retain')
  })

  test('writes isolated native profile defaults while retaining other rows and inherited config', async () => {
    const home = await temporaryHome()
    const webPath = join(home, 'profiles', 'web', 'cordis.patch.yml')
    const assistantPath = join(home, 'profiles', 'assistant', 'cordis.patch.yml')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'cordis.patch.yml'), '- id: permission\n  config:\n    presets:\n      custom:\n        sandbox: workspace-write\n        approval: ask\n    extra: !!js process.env.PERMISSION_EXTRA\n', 'utf8')
    await writeFile(webPath, '# web patch\n- id: unrelated\n  config: { retained: true }\n', 'utf8')
    await setPermissionDefault({ dshHome: home, profile: 'web', preset: 'workspace-write' })
    await setPermissionDefault({ dshHome: home, profile: 'assistant', preset: 'danger-full-access' })
    const web = await readFile(webPath, 'utf8')
    const assistant = await readFile(assistantPath, 'utf8')
    expect(web).toContain('# web patch')
    expect(web).toContain('retained: true')
    expect(web).toContain('extra: !!js process.env.PERMISSION_EXTRA')
    expect(web).toContain('defaultPreset: workspace-write')
    expect(assistant).toContain('defaultPreset: danger-full-access')
    expect(assistant).toContain('custom:')
    await setPermissionDefault({ dshHome: home, profile: 'web', preset: 'workspace-write' })
    expect(await readFile(webPath, 'utf8')).toBe(web)
    await expect(readFile(join(home, 'settings.yaml'), 'utf8')).rejects.toThrow()
  })

  test('keeps the native read-only preset on a fresh profile override', async () => {
    const home = await temporaryHome()
    const path = await setPermissionDefault({ dshHome: home, profile: 'web', preset: 'workspace-write' })
    const patch = await readFile(path, 'utf8')
    expect(patch).toContain('read-only:')
    expect(patch).toContain('defaultPreset: workspace-write')
  })

  test('rejects malformed native profile patch without replacing it', async () => {
    const home = await temporaryHome()
    const profileDir = join(home, 'profiles', 'web')
    await mkdir(profileDir, { recursive: true })
    const path = join(profileDir, 'cordis.patch.yml')
    await writeFile(path, 'notASequence: true\n', 'utf8')
    await expect(setPermissionDefault({ dshHome: home, profile: 'web', preset: 'auto' }))
      .rejects.toThrow('top-level YAML sequence')
    expect(await readFile(path, 'utf8')).toBe('notASequence: true\n')
  })

  test('rejects pending legacy permission import without changing either file', async () => {
    const home = await temporaryHome()
    const settingsPath = join(home, 'settings.yaml')
    const source = 'permission: { defaultPreset: workspace-write }\n'
    await writeFile(settingsPath, source, 'utf8')
    await expect(setPermissionDefault({ dshHome: home, profile: 'web', preset: 'danger-full-access' }))
      .rejects.toThrow('pending legacy settings.yaml permission section')
    expect(await readFile(settingsPath, 'utf8')).toBe(source)
    await expect(readFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')).rejects.toThrow()
  })

  test('defaults the explicitly invoked setup helper to full access', () => {
    const args = parsePermissionSetupArgs(['--dsh-home', '/tmp/dsh'])
    expect(args.preset).toBe('danger-full-access')
  })

  test.each(['workspace-write', 'auto', 'danger-full-access'])('honors an explicit %s override', preset => {
    expect(parsePermissionSetupArgs(['--dsh-home', '/tmp/dsh', '--preset', preset]).preset).toBe(preset)
  })

  test('fails closed for unsafe paths and invalid preset names', () => {
    expect(() => parsePermissionSetupArgs(['--dsh-home', 'relative', '--preset', 'auto'])).toThrow('absolute path')
    expect(() => parsePermissionSetupArgs(['--dsh-home', '/tmp/dsh', '--preset', 'full'])).toThrow('preset must be')
    expect(() => parsePermissionSetupArgs(['--dsh-home', '/tmp/dsh', '--profile', '../other'])).toThrow('valid profile name')
  })
})
