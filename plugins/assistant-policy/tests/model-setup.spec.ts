import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { parse } from 'yaml'
import {
  applyModelSetup,
  deriveApiKeyEnv,
  parseModelSetupArgs,
  resolveModelSetup,
  runModelSetup,
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

  test('serializes a freshly created settings file in block style, not a single flow line', async () => {
    const home = await temporaryHome()
    // No settings.yaml exists: the document is parsed from '{}', whose flow-style
    // root map would otherwise render as `{ agent-default-model: { ... } }`.
    const resolved = resolveModelSetup(parseModelSetupArgs(['--dsh-home', home, '--provider', 'traex-agent']))
    const result = await applyModelSetup(resolved)

    const text = await readFile(result.settingsPath, 'utf8')
    expect(text).not.toMatch(/^\{/u)
    expect(text).toMatch(/^agent-default-model:\s*$/mu)
    expect(text).toMatch(/^\s+provider:\s+traex-agent\s*$/mu)
    expect(parse(text)['agent-default-model']).toEqual({ provider: 'traex-agent', model: 'default' })
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

  test('default-if-absent selects only a fresh target profile and repeats without changing its patch', async () => {
    const home = await temporaryHome()
    const args = ['--dsh-home', home, '--provider', 'traex-agent', '--enable-in-profile', 'web',
      '--default-if-absent', '--agent-command', '/opt/traex/bin/traex']
    const resolved = resolveModelSetup(parseModelSetupArgs(args))
    const first = await applyModelSetup(resolved)
    expect(first.settingsUpdated).toBe(false)
    expect(first.profileDefaultAction).toBe('set')
    expect(first.routeAction).toBe('enabled')
    expect(first.agentCommandAction).toBe('set')
    await expect(readFile(first.settingsPath, 'utf8')).rejects.toThrow()
    const initialPatch = await readFile(first.profilePatchPath!, 'utf8')
    expect(initialPatch).toContain('id: agent-default-model')
    expect(initialPatch).toContain('provider: traex-agent')
    expect(initialPatch).toContain('model: default')
    expect(initialPatch).toContain('command: /opt/traex/bin/traex')
    expect(initialPatch).toContain("cwd: !!js dshHomePath('assistant-workspace')")

    const second = await applyModelSetup(resolved)
    expect(second.profileDefaultAction).toBe('preserved-profile-patch')
    expect(second.routeAction).toBe('already-enabled')
    expect(second.agentCommandAction).toBe('preserved')
    expect(await readFile(second.profilePatchPath!, 'utf8')).toBe(initialPatch)
    expect((initialPatch.match(/id: agent-default-model/gu) ?? [])).toHaveLength(1)
    await expect(readFile(second.settingsPath, 'utf8')).rejects.toThrow()
  })

  test.each([
    'agent-default-model: { provider: super-relay, model: custom }\n',
    'theme: dark\nagent-default-model:\n  provider: super-relay\n  model: custom\n  reasoningEffort: high\n',
  ])('default-if-absent preserves an explicit settings selection (%s)', async settingsSource => {
    const home = await temporaryHome()
    await writeFile(join(home, 'settings.yaml'), settingsSource, 'utf8')
    const result = await applyModelSetup(resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', home, '--provider', 'traex-agent', '--enable-in-profile', 'web', '--default-if-absent',
    ])))
    expect(result.profileDefaultAction).toBe('preserved-settings')
    expect(result.settingsUpdated).toBe(false)
    expect(await readFile(result.settingsPath, 'utf8')).toBe(settingsSource)
    const patch = await readFile(result.profilePatchPath!, 'utf8')
    expect(patch).toContain('id: dsh-enhanced-traex-acp-provider')
    expect(patch).not.toContain('id: agent-default-model')
  })

  test.each(['home', 'profile'] as const)('default-if-absent preserves an explicit %s patch default', async layer => {
    const home = await temporaryHome()
    const profileDir = join(home, 'profiles', 'web')
    await mkdir(profileDir, { recursive: true })
    const selectedPath = layer === 'home' ? join(home, 'cordis.patch.yml') : join(profileDir, 'cordis.patch.yml')
    const source = '- id: agent-default-model\n  config: { provider: deepseek-official, model: deepseek-v4-flash }\n'
    await writeFile(selectedPath, source, 'utf8')
    const result = await applyModelSetup(resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', home, '--provider', 'traex-agent', '--enable-in-profile', 'web', '--default-if-absent',
    ])))
    expect(result.profileDefaultAction).toBe(layer === 'home' ? 'preserved-home-patch' : 'preserved-profile-patch')
    const patch = await readFile(result.profilePatchPath!, 'utf8')
    expect(patch).toContain('id: dsh-enhanced-traex-acp-provider')
    if (layer === 'home') {
      expect(await readFile(selectedPath, 'utf8')).toBe(source)
      expect(patch).not.toContain('id: agent-default-model')
    } else {
      expect(patch).toContain('provider: deepseek-official')
      expect((patch.match(/id: agent-default-model/gu) ?? [])).toHaveLength(1)
    }
    await expect(readFile(result.settingsPath, 'utf8')).rejects.toThrow()
  })

  test('default-if-absent recognizes an inserted home default row', async () => {
    const home = await temporaryHome()
    const source = '- insert:\n    - id: agent-default-model\n      config: { provider: super-relay, model: custom }\n'
    await writeFile(join(home, 'cordis.patch.yml'), source, 'utf8')
    const result = await applyModelSetup(resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', home, '--provider', 'traex-agent', '--enable-in-profile', 'web', '--default-if-absent',
    ])))
    expect(result.profileDefaultAction).toBe('preserved-home-patch')
    expect(await readFile(join(home, 'cordis.patch.yml'), 'utf8')).toBe(source)
    expect(await readFile(result.profilePatchPath!, 'utf8')).not.toContain('id: agent-default-model')
  })

  test('default-if-absent CLI reports a preserved selection without claiming a settings write', async () => {
    const home = await temporaryHome()
    await writeFile(join(home, 'settings.yaml'), 'agent-default-model: { provider: deepseek-official, model: deepseek-v4-flash }\n', 'utf8')
    const chunks: string[] = []
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { chunks.push(String(chunk)); return true })
    try {
      await runModelSetup(['--dsh-home', home, '--provider', 'traex-agent', '--enable-in-profile', 'web', '--default-if-absent'])
    } finally { output.mockRestore() }
    const printed = chunks.join('')
    expect(printed).toContain('Preserved existing default model selection')
    expect(printed).toContain('unchanged (--default-if-absent)')
    expect(printed).not.toContain('Updated')
  })

  test('enable-only changes only the profile even when settings is invalid YAML', async () => {
    const home = await temporaryHome()
    const settingsPath = join(home, 'settings.yaml')
    await writeFile(settingsPath, '[invalid\n', 'utf8')
    const args = ['--dsh-home', home, '--provider', 'traex-agent', '--enable-in-profile', 'web', '--enable-only']
    const chunks: string[] = []
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { chunks.push(String(chunk)); return true })
    try { await runModelSetup(args) } finally { output.mockRestore() }
    const printed = chunks.join('')
    expect(printed).toContain('Left')
    expect(printed).not.toContain('Updated settings')
    expect(await readFile(settingsPath, 'utf8')).toBe('[invalid\n')
    const patch = await readFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('id: dsh-enhanced-traex-acp-provider')
    expect(patch).not.toContain('id: agent-default-model')
  })

  test('agent-command fills only a missing command and preserves operator command and cwd', async () => {
    const home = await temporaryHome()
    const patchPath = join(home, 'profiles', 'web', 'cordis.patch.yml')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(patchPath, "- id: dsh-enhanced-traex-acp-provider\n  config:\n    enabled: false\n    cwd: !!js dshHomePath('custom-ws')\n", 'utf8')
    const first = await applyModelSetup(resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', home, '--provider', 'traex-agent', '--enable-in-profile', 'web', '--enable-only', '--agent-command', '/first/traex',
    ])))
    expect(first.agentCommandAction).toBe('set')
    const second = await applyModelSetup(resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', home, '--provider', 'traex-agent', '--enable-in-profile', 'web', '--enable-only', '--agent-command', '/second/traex',
    ])))
    expect(second.agentCommandAction).toBe('preserved')
    const patch = await readFile(patchPath, 'utf8')
    expect(patch).toContain('command: /first/traex')
    expect(patch).not.toContain('/second/traex')
    expect(patch).toContain("cwd: !!js dshHomePath('custom-ws')")
    expect(patch).toContain('enabled: true')
  })

  test('enabling inherits home route config when the profile has no route override', async () => {
    const home = await temporaryHome()
    const profileDir = join(home, 'profiles', 'web')
    await mkdir(profileDir, { recursive: true })
    const homePatch = "- id: dsh-enhanced-traex-acp-provider\n  config:\n    command: /operator/traex\n    cwd: !!js dshHomePath('operator-ws')\n    timeoutMs: 9000\n"
    await writeFile(join(home, 'cordis.patch.yml'), homePatch, 'utf8')
    await writeFile(join(profileDir, 'cordis.patch.yml'), '# profile has no TraeX override\n', 'utf8')
    const result = await applyModelSetup(resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', home, '--provider', 'traex-agent', '--enable-in-profile', 'web', '--enable-only', '--agent-command', '/detected/traex',
    ])))
    expect(result.agentCommandAction).toBe('preserved')
    const profilePatch = await readFile(result.profilePatchPath!, 'utf8')
    expect(profilePatch).toContain('command: /operator/traex')
    expect(profilePatch).not.toContain('/detected/traex')
    expect(profilePatch).toContain("cwd: !!js dshHomePath('operator-ws')")
    expect(profilePatch).toContain('timeoutMs: 9000')
    expect(profilePatch).toContain('enabled: true')
    expect(await readFile(join(home, 'cordis.patch.yml'), 'utf8')).toBe(homePatch)
  })

  test('an inserted profile route keeps its explicit command and cwd', async () => {
    const home = await temporaryHome()
    const profileDir = join(home, 'profiles', 'web')
    await mkdir(profileDir, { recursive: true })
    const profilePath = join(profileDir, 'cordis.patch.yml')
    await writeFile(profilePath, "- insert:\n    - id: dsh-enhanced-traex-acp-provider\n      name: '@dsh-enhanced/traex-acp-provider'\n      disabled: true\n      config:\n        command: /profile/traex\n        cwd: !!js dshHomePath('profile-ws')\n        logDiagnostics: true\n", 'utf8')
    const result = await applyModelSetup(resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', home, '--provider', 'traex-agent', '--enable-in-profile', 'web', '--enable-only', '--agent-command', '/detected/traex',
    ])))
    expect(result.agentCommandAction).toBe('preserved')
    const patch = await readFile(profilePath, 'utf8')
    expect(patch).toContain('command: /profile/traex')
    expect(patch).toContain("cwd: !!js dshHomePath('profile-ws')")
    expect(patch).toContain('logDiagnostics: true')
    expect(patch).toContain('enabled: true')
    expect(patch).toContain('disabled: false')
    expect(patch).not.toContain('disabled: true')
    expect(patch).not.toContain('/detected/traex')
    expect((patch.match(/id: dsh-enhanced-traex-acp-provider/gu) ?? [])).toHaveLength(1)
  })

  test('a home-disabled route gets a profile row that opens both enable gates', async () => {
    const home = await temporaryHome()
    const homePatch = "- id: dsh-enhanced-traex-acp-provider\n  disabled: true\n  config:\n    command: /operator/traex\n    cwd: !!js dshHomePath('operator-ws')\n"
    await writeFile(join(home, 'cordis.patch.yml'), homePatch, 'utf8')
    const result = await applyModelSetup(resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', home, '--provider', 'traex-agent', '--enable-in-profile', 'web', '--enable-only', '--agent-command', '/detected/traex',
    ])))
    expect(result.routeAction).toBe('enabled')
    expect(result.agentCommandAction).toBe('preserved')
    const patch = await readFile(result.profilePatchPath!, 'utf8')
    expect(patch).toContain('disabled: false')
    expect(patch).toContain('enabled: true')
    expect(patch).toContain('command: /operator/traex')
    expect(patch).toContain("cwd: !!js dshHomePath('operator-ws')")
    expect(await readFile(join(home, 'cordis.patch.yml'), 'utf8')).toBe(homePatch)
  })

  test('a later home config replaces earlier fields before profile enablement', async () => {
    const home = await temporaryHome()
    await writeFile(join(home, 'cordis.patch.yml'),
      "- id: dsh-enhanced-traex-acp-provider\n  config:\n    command: /old/traex\n    cwd: !!js dshHomePath('old-ws')\n- id: dsh-enhanced-traex-acp-provider\n  config:\n    timeoutMs: 9000\n", 'utf8')
    const result = await applyModelSetup(resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', home, '--provider', 'traex-agent', '--enable-in-profile', 'web', '--enable-only', '--agent-command', '/detected/traex',
    ])))
    const patch = await readFile(result.profilePatchPath!, 'utf8')
    expect(result.agentCommandAction).toBe('set')
    expect(patch).toContain('timeoutMs: 9000')
    expect(patch).toContain('command: /detected/traex')
    expect(patch).toContain("cwd: !!js dshHomePath('assistant-workspace')")
    expect(patch).not.toContain('/old/traex')
    expect(patch).not.toContain('old-ws')
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
    expect(() => resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', '/tmp/dsh', '--provider', 'traex-agent', '--enable-in-profile', 'web', '--enable-only', '--default-if-absent',
    ]))).toThrow('mutually exclusive')
    expect(() => resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', '/tmp/dsh', '--provider', 'traex-agent', '--enable-only',
    ]))).toThrow('require --enable-in-profile')
    expect(() => resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', '/tmp/dsh', '--provider', 'traex-agent', '--enable-in-profile', 'web', '--agent-command', 'relative/traex',
    ]))).toThrow('absolute path')
    expect(() => resolveModelSetup(parseModelSetupArgs([
      '--dsh-home', '/tmp/dsh', '--provider', 'deepseek-official', '--enable-in-profile', 'web', '--enable-only',
    ]))).toThrow('only applies to an agent route')
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
