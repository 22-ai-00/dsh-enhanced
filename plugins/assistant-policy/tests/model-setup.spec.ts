import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import {
  applyModelSetup,
  deriveApiKeyEnv,
  parseModelSetupArgs,
  resolveModelSetup,
} from '../src/model-setup.ts'

const temporaryRoots: string[] = []

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-model-setup-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('model setup', () => {
  test('writes only the deepseek-official default selection while preserving unrelated settings', async () => {
    const home = await temporaryHome()
    await writeFile(join(home, 'settings.yaml'), 'theme: dark\npermission:\n  defaultPreset: auto\n', 'utf8')

    const resolved = resolveModelSetup(parseModelSetupArgs(['--dsh-home', home]))
    const result = await applyModelSetup(resolved)

    const settings = parse(await readFile(result.settingsPath, 'utf8')) as any
    expect(settings.theme).toBe('dark')
    expect(settings.permission.defaultPreset).toBe('auto')
    expect(settings['agent-default-model']).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    expect(settings['llm-pi-ai']).toBeUndefined()
    expect(result.credentialsPath).toBeUndefined()
  })

  test('declares a custom gateway route under llm-pi-ai and stores the key from the environment', async () => {
    const home = await temporaryHome()
    const resolved = resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', home, '--provider', 'super-relay', '--model', 'glm5.2',
      '--base-url', 'https://super-relay.example/v1', '--display-name', 'Super Relay', '--store-key',
    ]))

    const previous = process.env.DSH_ENHANCED_MODEL_API_KEY
    process.env.DSH_ENHANCED_MODEL_API_KEY = 'plat-secret-value'
    let result
    try {
      result = await applyModelSetup(resolved)
    } finally {
      if (previous === undefined) delete process.env.DSH_ENHANCED_MODEL_API_KEY
      else process.env.DSH_ENHANCED_MODEL_API_KEY = previous
    }

    const settings = parse(await readFile(result.settingsPath, 'utf8')) as any
    expect(settings['agent-default-model']).toEqual({ provider: 'super-relay', model: 'glm5.2' })
    expect(settings['llm-pi-ai'].providers['super-relay']).toEqual({
      displayName: 'Super Relay',
      apiKeyEnv: 'SUPER_RELAY_API_KEY',
      api: 'openai-completions',
      baseURL: 'https://super-relay.example/v1',
      models: [{ id: 'glm5.2', name: 'glm5.2' }],
    })
    const credentials = parse(await readFile(result.credentialsPath!, 'utf8')) as any
    expect(credentials.SUPER_RELAY_API_KEY).toBe('plat-secret-value')
  })

  test('derives POSIX credential references and defaults deepseek to DEEPSEEK_API_KEY', () => {
    expect(deriveApiKeyEnv('deepseek-official')).toBe('DEEPSEEK_API_KEY')
    expect(deriveApiKeyEnv('super-relay')).toBe('SUPER_RELAY_API_KEY')
    expect(deriveApiKeyEnv('acme.gateway')).toBe('ACME_GATEWAY_API_KEY')
  })

  test('fails closed for unsafe paths, missing custom base url, and misapplied transport fields', () => {
    expect(() => resolveModelSetup(parseModelSetupArgs(['--dsh-home', 'relative']))).toThrow('absolute path')
    expect(() => resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', '/tmp/dsh', '--provider', 'super-relay', '--model', 'glm5.2',
    ]))).toThrow('requires --base-url')
    expect(() => resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', '/tmp/dsh', '--base-url', 'https://x/v1',
    ]))).toThrow('only apply to a custom gateway route')
  })

  test('refuses to store a key when neither the key env var nor the credential reference is set', async () => {
    const home = await temporaryHome()
    const resolved = resolveModelSetup(parseModelSetupArgs(['--dsh-home', home, '--store-key']))

    const previousKey = process.env.DSH_ENHANCED_MODEL_API_KEY
    const previousRef = process.env.DEEPSEEK_API_KEY
    delete process.env.DSH_ENHANCED_MODEL_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    try {
      await expect(applyModelSetup(resolved)).rejects.toThrow('no API key found')
    } finally {
      if (previousKey !== undefined) process.env.DSH_ENHANCED_MODEL_API_KEY = previousKey
      if (previousRef !== undefined) process.env.DEEPSEEK_API_KEY = previousRef
    }
    await expect(readFile(join(home, 'settings.yaml'), 'utf8')).rejects.toThrow()
  })

  test('an agent route sets only the default model and needs no credential', async () => {
    const home = await temporaryHome()
    const resolved = resolveModelSetup(parseModelSetupArgs(['--dsh-home', home, '--provider', 'traex-agent']))
    expect(resolved.kind).toBe('agent')
    expect(resolved.model).toBe('default')
    expect(resolved.storeKey).toBe(false)

    const result = await applyModelSetup(resolved)
    const settings = parse(await readFile(result.settingsPath, 'utf8')) as any
    expect(settings['agent-default-model']).toEqual({ provider: 'traex-agent', model: 'default' })
    expect(settings['llm-pi-ai']).toBeUndefined()
    expect(result.credentialsPath).toBeUndefined()
    expect(result.profilePatchPath).toBeUndefined()
  })

  test('enabling an agent route flips its bundle row while preserving other rows and !!js config', async () => {
    const home = await temporaryHome()
    const profileDir = join(home, 'profiles', 'web')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'cordis.patch.yml'),
      '# my patch layer\n- id: dsh-enhanced-personal-assistant\n  config:\n    x: 1\n', 'utf8')

    const resolved = resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', home, '--provider', 'traex-agent', '--enable-in-profile', 'web',
    ]))
    const result = await applyModelSetup(resolved)
    expect(result.profilePatchPath).toBe(join(profileDir, 'cordis.patch.yml'))

    const patch = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('# my patch layer')
    expect(patch).toContain('dsh-enhanced-personal-assistant')
    // The freshly added row is enabled and carries the required !!js cwd.
    expect(patch).toContain('id: dsh-enhanced-traex-acp-provider')
    expect(patch).toContain('enabled: true')
    expect(patch).toContain("cwd: !!js dshHomePath('assistant-workspace')")
  })

  test('enabling preserves an operator cwd override and only flips enabled', async () => {
    const home = await temporaryHome()
    const profileDir = join(home, 'profiles', 'web')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'cordis.patch.yml'),
      "- id: dsh-enhanced-traex-acp-provider\n  config:\n    enabled: false\n    cwd: !!js dshHomePath('custom-ws')\n", 'utf8')

    const resolved = resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', home, '--provider', 'traex-agent', '--enable-in-profile', 'web',
    ]))
    await applyModelSetup(resolved)

    const patch = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('enabled: true')
    expect(patch).toContain("cwd: !!js dshHomePath('custom-ws')")
    expect(patch).not.toContain('assistant-workspace')
  })

  test('agent routes reject key storage, gateway transport, and misused profile enable', () => {
    expect(() => resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', '/tmp/dsh', '--provider', 'traex-agent', '--store-key',
    ]))).toThrow('--store-key does not apply')
    expect(() => resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', '/tmp/dsh', '--provider', 'traex-agent', '--base-url', 'https://x/v1',
    ]))).toThrow('do not apply to the agent route')
    expect(() => resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', '/tmp/dsh', '--provider', 'deepseek-official', '--enable-in-profile', 'web',
    ]))).toThrow('only applies to an agent route')
    expect(() => resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', '/tmp/dsh', '--provider', 'traex-agent', '--enable-in-profile', '../evil',
    ]))).toThrow('valid profile name')
  })

  test('a non-sequence profile patch fails closed instead of being clobbered', async () => {
    const home = await temporaryHome()
    const profileDir = join(home, 'profiles', 'web')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'cordis.patch.yml'), 'notASequence: true\n', 'utf8')

    const resolved = resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', home, '--provider', 'traex-agent', '--enable-in-profile', 'web',
    ]))
    await expect(applyModelSetup(resolved)).rejects.toThrow('top-level YAML sequence')
    // settings.yaml is written before the patch step, but the patch is untouched.
    expect(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe('notASequence: true\n')
  })
})
