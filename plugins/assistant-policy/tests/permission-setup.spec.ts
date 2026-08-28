import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { parsePermissionSetupArgs, setPermissionDefault } from '../src/permission-setup.ts'

const temporaryRoots: string[] = []

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

  test('fails closed for unsafe paths and invalid preset names', () => {
    expect(() => parsePermissionSetupArgs(['--dsh-home', 'relative', '--preset', 'auto'])).toThrow('absolute path')
    expect(() => parsePermissionSetupArgs(['--dsh-home', '/tmp/dsh', '--preset', 'full'])).toThrow('preset must be')
  })
})
