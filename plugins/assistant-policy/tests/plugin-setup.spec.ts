import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from 'yaml'
import {
  applyRecommendedPluginPreset,
  coerceConfigValue,
  isSecretConfigKey,
  listProfilePlugins,
  parsePluginSetupArgs,
  type PluginSetupIo,
  resolvePluginId,
  runPluginSetup,
  setPluginConfigValue,
  setPluginEnabled,
  showProfilePlugin,
  unsetPluginConfigValue,
} from '../src/plugin-setup.ts'

const bundles = `
- id: dsh-enhanced-assistant-policy
  name: '@dsh-enhanced/assistant-policy'
  config:
    toolDefaultEffect: deny
- id: dsh-enhanced-assistant-work-items
  name: '@dsh-enhanced/assistant-work-items'
  config:
    enabled: false
    mode: observe
    databasePath: !!js dshHomePath('assistant-work-items/state.sqlite')
    intakeSourceId: work-items/v1
- id: dsh-enhanced-assistant-delivery
  name: '@dsh-enhanced/assistant-delivery'
  config:
    schedulerEnabled: true
    maxAttempts: 5
    ownerRoutes: []
- id: dsh-enhanced-event-triggers
  name: '@dsh-enhanced/event-triggers'
  config:
    pollerEnabled: false
    allowedHttpHosts: []
- id: dsh-enhanced-lark-channel
  name: '@dsh-enhanced/lark-channel'
  config:
    enabled: false
    tenant: replace-with-tenant-key
    appId: cli_0000000000000000
    appSecret: hunter2
    appSecretHandle: lark/app-secret
- id: dsh-enhanced-assistant-memory-learning
  name: '@dsh-enhanced/assistant-memory-learning'
  disabled: true
  config: {}
`

const temporaryRoots: string[] = []

async function temporaryHome(profiles: readonly string[] = ['web']): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-setup-'))
  temporaryRoots.push(root)
  for (const profile of profiles) await mkdir(join(root, 'profiles', profile), { recursive: true })
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Emulates the loader: bundle rows, then home patch, then profile patch; a row config replaces as a whole. */
async function fixtureDump(home: string, profile: string): Promise<YAMLSeq> {
  const rows = parseDocument(bundles).contents as YAMLSeq
  for (const path of [join(home, 'cordis.patch.yml'), join(home, 'profiles', profile, 'cordis.patch.yml')]) {
    let source: string
    try { source = await readFile(path, 'utf8') } catch { continue }
    const patch = parseDocument(source)
    if (patch.errors.length > 0) throw new Error('fixture dump: invalid patch')
    if (!isSeq(patch.contents)) continue
    for (const entry of patch.contents.items) {
      if (!isMap(entry)) continue
      const target = rows.items.find(row => isMap(row) && row.get('id') === entry.get('id')) as YAMLMap | undefined
      if (target === undefined) continue
      if (entry.has('disabled')) target.set('disabled', entry.get('disabled'))
      const config = entry.get('config', true)
      if (isMap(config)) target.set('config', config.clone())
    }
  }
  return rows
}

const options = { readDump: fixtureDump }

async function profilePatch(home: string, profile = 'web'): Promise<string> {
  return readFile(join(home, 'profiles', profile, 'cordis.patch.yml'), 'utf8')
}

function memoryIo(answers: string[] = [], isTTY = false): PluginSetupIo & { output: string } {
  const io = {
    output: '',
    isTTY,
    write(text: string) { io.output += text },
    async ask(question: string) { io.output += question; return answers.shift() ?? 'q' },
  }
  return io
}

describe('plugin setup: naming and validation', () => {
  test('resolves short slugs, package names and row ids', () => {
    const ids = ['dsh-enhanced-assistant-work-items', 'dsh-enhanced-event-triggers']
    expect(resolvePluginId('work-items', ids)).toBe('dsh-enhanced-assistant-work-items')
    expect(resolvePluginId('assistant-work-items', ids)).toBe('dsh-enhanced-assistant-work-items')
    expect(resolvePluginId('@dsh-enhanced/event-triggers', ids)).toBe('dsh-enhanced-event-triggers')
    expect(resolvePluginId('dsh-enhanced-event-triggers', ids)).toBe('dsh-enhanced-event-triggers')
    expect(resolvePluginId('nope', ids)).toBeUndefined()
  })

  test('detects secret-like keys without flagging handles, env names or token budgets', () => {
    for (const key of ['appSecret', 'apiKey', 'api_key', 'password', 'accessToken', 'privateKey', 'cookie']) expect(isSecretConfigKey(key)).toBe(true)
    for (const key of ['appSecretHandle', 'apiKeyEnv', 'maxOutputTokens', 'tokenTtlMs', 'credentialHandle', 'secretRef', 'enabled']) expect(isSecretConfigKey(key)).toBe(false)
  })

  test('coerces values to the current type and rejects mismatches', () => {
    const doc = parseDocument('flag: true\ncount: 5\nname: x\nlist: []\nmap: {}\nexpr: !!js dshHomePath("a")\n')
    const map = doc.contents as YAMLMap
    expect(coerceConfigValue('row', 'flag', 'off', map.get('flag', true))).toBe(false)
    expect(coerceConfigValue('row', 'count', '7', map.get('count', true))).toBe(7)
    expect(coerceConfigValue('row', 'name', '42', map.get('name', true))).toBe('42')
    expect(coerceConfigValue('row', 'list', '["a"]', map.get('list', true))).toEqual(['a'])
    expect(() => coerceConfigValue('row', 'flag', 'maybe', map.get('flag', true))).toThrow(/expects a boolean/u)
    expect(() => coerceConfigValue('row', 'count', 'many', map.get('count', true))).toThrow(/expects a number/u)
    expect(() => coerceConfigValue('row', 'list', '{}', map.get('list', true))).toThrow(/JSON array/u)
    expect(() => coerceConfigValue('row', 'expr', 'x', map.get('expr', true))).toThrow(/!!js expression/u)
    expect(() => coerceConfigValue('row', 'missing', 'x', undefined)).toThrow(/--force/u)
    expect(coerceConfigValue('row', 'missing', '3', undefined, true)).toBe(3)
    expect(coerceConfigValue('dsh-enhanced-assistant-work-items', 'mode', 'active', undefined)).toBe('active')
    expect(() => coerceConfigValue('dsh-enhanced-assistant-work-items', 'mode', 'loud', undefined)).toThrow(/observe, active/u)
    expect(coerceConfigValue('dsh-enhanced-assistant-work-items', 'follows.eventTriggers.enabled', 'true', undefined)).toBe(true)
    expect(() => coerceConfigValue('dsh-enhanced-assistant-work-items', 'follows.eventTriggers.enabled', 'maybe', undefined)).toThrow(/expects a boolean/u)
    expect(coerceConfigValue('dsh-enhanced-assistant-work-items', 'acceptance.autoSettle.enabled', 'on', undefined)).toBe(true)
    expect(coerceConfigValue('dsh-enhanced-assistant-work-items', 'acceptance.autoSettle.maxPerTick', '3', undefined)).toBe(3)
    expect(() => coerceConfigValue('dsh-enhanced-assistant-work-items', 'acceptance.autoSettle.maxPerTick', 'many', undefined)).toThrow(/expects a number/u)
    expect(coerceConfigValue('dsh-enhanced-assistant-work-items', 'acceptance.bindWorkerRun.enabled', 'on', undefined)).toBe(true)
    expect(coerceConfigValue('dsh-enhanced-assistant-work-items', 'acceptance.bindWorkerRun.maxPerTick', '4', undefined)).toBe(4)
    expect(() => coerceConfigValue('dsh-enhanced-assistant-work-items', 'acceptance.bindWorkerRun.enabled', 'maybe', undefined)).toThrow(/expects a boolean/u)
  })

  test('parses commands and rejects bad arity or options', () => {
    expect(parsePluginSetupArgs(['set', 'work-items', 'mode', 'observe', '--profile', 'web', '--dsh-home', '/tmp/x'])).toMatchObject({
      command: 'set', positionals: ['work-items', 'mode', 'observe'], profile: 'web', dshHome: '/tmp/x',
    })
    expect(parsePluginSetupArgs(['--dsh-home', '/tmp/x']).command).toBe('guided')
    expect(() => parsePluginSetupArgs(['enable', '--dsh-home', '/tmp/x'])).toThrow(/expects 1/u)
    expect(() => parsePluginSetupArgs(['frobnicate', '--dsh-home', '/tmp/x'])).toThrow(/unknown command/u)
    expect(() => parsePluginSetupArgs(['list', '--dsh-home', 'relative'])).toThrow(/absolute/u)
    expect(() => parsePluginSetupArgs(['list', '--dsh-home', '/tmp/x', '--profile', '../evil'])).toThrow(/profile name/u)
  })
})

describe('plugin setup: profile edits', () => {
  test('lists installed plugins, picking the only profile automatically', async () => {
    const home = await temporaryHome()
    const listed = await listProfilePlugins({ dshHome: home }, options)
    expect(listed.profile).toBe('web')
    const byId = new Map(listed.plugins.map(plugin => [plugin.id, plugin]))
    expect(byId.get('dsh-enhanced-assistant-work-items')).toMatchObject({ slug: 'assistant-work-items', loaded: true, enabled: false, overridden: false })
    expect(byId.get('dsh-enhanced-assistant-delivery')?.flags).toEqual({ schedulerEnabled: true })
    expect(byId.get('dsh-enhanced-assistant-memory-learning')?.loaded).toBe(false)
  })

  test('requires --profile when several profiles exist', async () => {
    const home = await temporaryHome(['web', 'headless'])
    await expect(listProfilePlugins({ dshHome: home }, options)).rejects.toThrow(/several profiles found \(headless, web\)/u)
  })

  test('enable clones the full effective config, flips both gates and keeps !!js and other rows', async () => {
    const home = await temporaryHome()
    await writeFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), '# keep me\n- id: permission\n  config:\n    defaultPreset: auto\n', 'utf8')
    const result = await setPluginEnabled({ dshHome: home, profile: 'web', plugin: 'work-items', enabled: true }, options)
    expect(result.changes).toEqual([{ id: 'dsh-enhanced-assistant-work-items', key: 'enabled', from: false, to: true }])
    const source = await profilePatch(home)
    expect(source).toContain('# keep me')
    expect(source).toContain('defaultPreset: auto')
    expect(source).toContain("databasePath: !!js dshHomePath('assistant-work-items/state.sqlite')")
    expect(source).toContain('intakeSourceId: work-items/v1')
    expect(source).toContain('enabled: true')
    expect((await stat(join(home, 'profiles', 'web', 'cordis.patch.yml'))).mode & 0o777).toBe(0o600)
    const again = await setPluginEnabled({ dshHome: home, profile: 'web', plugin: 'work-items', enabled: true }, options)
    expect(again.changed).toBe(false)
  })

  test('enable loads a disabled plugin and disable unloads it', async () => {
    const home = await temporaryHome()
    await setPluginEnabled({ dshHome: home, profile: 'web', plugin: 'memory-learning', enabled: true }, options)
    expect((await listProfilePlugins({ dshHome: home }, options)).plugins.find(plugin => plugin.slug === 'assistant-memory-learning')?.loaded).toBe(true)
    await setPluginEnabled({ dshHome: home, profile: 'web', plugin: 'event-triggers', enabled: false }, options)
    expect((await listProfilePlugins({ dshHome: home }, options)).plugins.find(plugin => plugin.slug === 'event-triggers')?.loaded).toBe(false)
  })

  test('set validates type, edits one key and unset restores the default', async () => {
    const home = await temporaryHome()
    await expect(setPluginConfigValue({ dshHome: home, profile: 'web', plugin: 'delivery', key: 'maxAttempts', value: 'lots' }, options)).rejects.toThrow(/expects a number/u)
    await expect(setPluginConfigValue({ dshHome: home, profile: 'web', plugin: 'delivery', key: 'mystery', value: '1' }, options)).rejects.toThrow(/--force/u)
    const result = await setPluginConfigValue({ dshHome: home, profile: 'web', plugin: 'delivery', key: 'maxAttempts', value: '9' }, options)
    expect(result.changes).toEqual([{ id: 'dsh-enhanced-assistant-delivery', key: 'maxAttempts', from: 5, to: 9 }])
    expect(await profilePatch(home)).toContain('schedulerEnabled: true')
    await setPluginConfigValue({ dshHome: home, profile: 'web', plugin: 'work-items', key: 'intakeLedger.enabled', value: 'true' }, options)
    expect((await showProfilePlugin({ dshHome: home, plugin: 'work-items' }, options)).config).toMatch(/intakeLedger:\n {2}enabled: true/u)
    await unsetPluginConfigValue({ dshHome: home, profile: 'web', plugin: 'delivery', key: 'maxAttempts' }, options)
    expect(await profilePatch(home)).not.toContain('maxAttempts')
  })

  test('refuses secrets, protected rows, authorization keys, Policy disable and placeholder Lark', async () => {
    const home = await temporaryHome()
    const target = { dshHome: home, profile: 'web' }
    await expect(setPluginConfigValue({ ...target, plugin: 'lark-channel', key: 'appSecret', value: 'x' }, options)).rejects.toThrow(/secret/u)
    await expect(setPluginConfigValue({ ...target, plugin: 'policy', key: 'toolDefaultEffect', value: 'allow' }, options)).rejects.toThrow(/not editable/u)
    await expect(setPluginConfigValue({ ...target, plugin: 'delivery', key: 'ownerRoutes', value: '[]' }, options)).rejects.toThrow(/authorization/u)
    await expect(setPluginEnabled({ ...target, plugin: 'policy', enabled: false }, options)).rejects.toThrow(/refusing to disable assistant-policy/u)
    await expect(setPluginEnabled({ ...target, plugin: 'lark-channel', enabled: true }, options)).rejects.toThrow(/dsh-lark-setup/u)
    await expect(setPluginEnabled({ ...target, plugin: 'not-installed', enabled: true }, options)).rejects.toThrow(/dsh plugin --profile web add @dsh-enhanced\/not-installed/u)
    await expect(readFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')).rejects.toThrow()
  })

  test('show redacts secret values but keeps handles', async () => {
    const home = await temporaryHome()
    const shown = await showProfilePlugin({ dshHome: home, plugin: 'lark-channel' }, options)
    expect(shown.config).toContain('appSecret: "[redacted]"')
    expect(shown.config).not.toContain('hunter2')
    expect(shown.config).toContain('appSecretHandle: lark/app-secret')
  })

  test('restores the previous patch when the dump fails or the value does not take effect', async () => {
    const home = await temporaryHome()
    const original = '- id: permission\n  config:\n    defaultPreset: auto\n'
    await writeFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), original, 'utf8')
    let calls = 0
    const failingAfterWrite = async (dshHome: string, profile: string) => {
      calls += 1
      if (calls > 1) throw new Error('dump exploded')
      return fixtureDump(dshHome, profile)
    }
    await expect(setPluginEnabled({ dshHome: home, profile: 'web', plugin: 'work-items', enabled: true }, { readDump: failingAfterWrite }))
      .rejects.toThrow(/verification failed, restored .*dump exploded/u)
    expect(await profilePatch(home)).toBe(original)

    const ignoresProfile = async () => parseDocument(bundles).contents as YAMLSeq
    await expect(setPluginConfigValue({ dshHome: home, profile: 'web', plugin: 'delivery', key: 'maxAttempts', value: '9' }, { readDump: ignoresProfile }))
      .rejects.toThrow(/did not take effect/u)
    expect(await profilePatch(home)).toBe(original)
  })

  test('dry run reports without writing', async () => {
    const home = await temporaryHome()
    const result = await setPluginEnabled({ dshHome: home, profile: 'web', plugin: 'work-items', enabled: true }, { ...options, dryRun: true })
    expect(result).toMatchObject({ dryRun: true, changed: true })
    await expect(readFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')).rejects.toThrow()
  })
})

describe('plugin setup: recommended preset', () => {
  test('turns on opt-in features of installed, loaded plugins only, idempotently', async () => {
    const home = await temporaryHome()
    const result = await applyRecommendedPluginPreset({ dshHome: home, profile: 'web' }, options)
    expect(result.changes).toEqual([
      { id: 'dsh-enhanced-assistant-work-items', key: 'enabled', from: false, to: true },
      { id: 'dsh-enhanced-assistant-work-items', key: 'intakeLedger.enabled', from: undefined, to: true },
      { id: 'dsh-enhanced-assistant-delivery', key: 'attentionAttachOverCap', from: undefined, to: true },
      { id: 'dsh-enhanced-event-triggers', key: 'pollerEnabled', from: false, to: true },
    ])
    expect(result.skipped).toEqual([{ id: 'dsh-enhanced-assistant-evaluation', reason: 'not installed' }])
    const source = await profilePatch(home)
    expect(source).toContain('mode: observe')
    expect(source).not.toContain('dsh-enhanced-lark-channel')
    expect(source).not.toContain('dsh-enhanced-assistant-policy')
    expect(source).not.toContain('dsh-enhanced-assistant-memory-learning')
    expect((await applyRecommendedPluginPreset({ dshHome: home, profile: 'web' }, options)).changed).toBe(false)
  })

  test('skips disabled plugins and active work-items that are not yet enabled', async () => {
    const home = await temporaryHome()
    await writeFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), [
      '- id: dsh-enhanced-event-triggers', '  disabled: true',
      '- id: dsh-enhanced-assistant-work-items', '  config:', '    enabled: false', '    mode: active', '',
    ].join('\n'), 'utf8')
    const result = await applyRecommendedPluginPreset({ dshHome: home, profile: 'web' }, options)
    expect(result.changes.map(change => change.id)).toEqual(['dsh-enhanced-assistant-delivery'])
    expect(result.skipped.map(skip => skip.id)).toEqual(expect.arrayContaining(['dsh-enhanced-event-triggers', 'dsh-enhanced-assistant-work-items']))
  })
})

describe('plugin setup: CLI', () => {
  test('non-interactive list, set and json preset', async () => {
    const home = await temporaryHome()
    const io = memoryIo()
    await runPluginSetup(['--dsh-home', home], io, options)
    expect(io.output).toContain('Profile web')
    expect(io.output).toMatch(/assistant-work-items\s+idle\s+enabled=false/u)
    await runPluginSetup(['set', 'event-triggers', 'pollerEnabled', 'yes', '--dsh-home', home], io, options)
    expect(io.output).toContain('dsh-enhanced-event-triggers.pollerEnabled: false -> true')
    const json = memoryIo()
    await runPluginSetup(['preset', '--json', '--dry-run', '--dsh-home', home], json, options)
    expect(JSON.parse(json.output)).toMatchObject({ dryRun: true, profile: 'web' })
  })

  test('terminal preset asks before writing', async () => {
    const home = await temporaryHome()
    const declined = memoryIo(['n'], true)
    await runPluginSetup(['preset', '--dsh-home', home], declined, options)
    expect(declined.output).toContain('Not applied.')
    await expect(readFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')).rejects.toThrow()
    const accepted = memoryIo(['y'], true)
    await runPluginSetup(['preset', '--dsh-home', home], accepted, options)
    expect(await profilePatch(home)).toContain('attentionAttachOverCap: true')
  })

  test('guided menu enables a plugin by number and reports refusals without exiting', async () => {
    const home = await temporaryHome()
    const listed = await listProfilePlugins({ dshHome: home }, options)
    const workItems = listed.plugins.findIndex(plugin => plugin.slug === 'assistant-work-items') + 1
    const io = memoryIo([String(workItems), 'e', 'lark-channel', 's', 'appSecret', 'x', 'q'], true)
    await runPluginSetup(['--dsh-home', home], io, options)
    expect(io.output).toContain('dsh-enhanced-assistant-work-items.enabled: false -> true')
    expect(io.output).toContain('looks like a secret')
    expect(await profilePatch(home)).not.toContain('appSecret')
  })
})
