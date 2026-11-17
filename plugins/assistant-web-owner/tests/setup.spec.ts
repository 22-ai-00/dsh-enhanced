import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { isSeq, parseDocument } from 'yaml'
import { pairPrincipalLocally } from '@dsh-enhanced/assistant-delivery'
import { configureWebOwner, prepareWebOwnerProfile, type WebOwnerSetupInput } from '../src/setup.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const dshHome = await mkdtemp(join(tmpdir(), 'web-owner-setup-')); roots.push(dshHome)
  const input: WebOwnerSetupInput = { dshHome, profile: 'web', workspace: join(dshHome, 'workspace'), preset: 'standard' }
  const directory = join(dshHome, 'profiles', 'web'); await mkdir(directory, { recursive: true })
  const bundles = await Promise.all(['personal-assistant', 'assistant-delivery'].map(async slug => {
    const text = await readFile(new URL(`../../${slug}/cordis.patch.yml`, import.meta.url), 'utf8')
    const doc = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
    // Extract the actual published row without evaluating its tagged path expressions.
    const rows = doc.toJS() as Array<{ insert?: unknown[] }>
    const index = rows.findIndex(row => row.insert !== undefined)
    const node = doc.getIn([index, 'insert', 0], true)
    const exported = parseDocument('[]')
    if (isSeq(exported.contents)) exported.contents.flow = false
    exported.add(node)
    return exported.toString()
  }))
  const effective = bundles.join('\n') + '\n- id: dsh-enhanced-assistant-goals\n  name: "@dsh-enhanced/assistant-goals"\n- id: dsh-enhanced-assistant-web-owner\n  name: "@dsh-enhanced/assistant-web-owner"\n'
  return { input, effective, path: join(directory, 'cordis.patch.yml') }
}
function ownerRows(path: string): unknown[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare('SELECT * FROM delivery_principals').all() } finally { db.close() }
}

describe('local Web owner profile setup', () => {
  test('materializes real bundle defaults, preserves tags/custom rules and is byte-idempotent', async () => {
    const { input, effective, path } = await fixture()
    const source = '# Preserve me\n- id: custom\n  name: local-plugin\n  config:\n    expression: !!js dshHomePath("custom")\n'
    await writeFile(path, source)
    const plan = prepareWebOwnerProfile(input, source, effective)
    expect(plan.patch).toContain('!!js')
    expect(plan.patch).toContain('personalMemory:')
    expect(plan.patch).toContain('assistantAutomations:')
    expect(plan.patch).toContain('dsh-enhanced-foreground-capability-*')
    expect(plan.patch).toContain('web/web/local/operator')
    expect(plan.patch).toContain('# Preserve me')
    expect(plan.patch).toContain(`defaultWorkspace: ${input.workspace}`)
    expect(plan.patch).not.toContain(`defaultWorkspace: !!js ${input.workspace}`)
    await configureWebOwner(input, effective)
    const first = await readFile(path, 'utf8')
    const owner = ownerRows(plan.databasePath)
    expect(owner).toHaveLength(1)
    await configureWebOwner(input, first)
    expect(await readFile(path, 'utf8')).toBe(first)
    expect(ownerRows(plan.databasePath)).toEqual(owner)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(join(input.dshHome, 'settings.yaml'), 'utf8').catch(() => undefined)).toBeUndefined()
  })
  test('does not rotate another owner or replace the original profile', async () => {
    const { input, effective, path } = await fixture()
    const source = '# original\n[]\n'; await writeFile(path, source)
    const plan = prepareWebOwnerProfile(input, source, effective)
    pairPrincipalLocally({ databasePath: plan.databasePath, principal: { channel: 'lark', account: 'bot', tenant: 'tenant', user: 'owner' } })
    const before = ownerRows(plan.databasePath)
    await expect(configureWebOwner(input, effective)).rejects.toThrow()
    expect(ownerRows(plan.databasePath)).toEqual(before)
    expect(await readFile(path, 'utf8')).toBe(source)
  })
  test('preserves explicit rules and rejects a changed managed grant or owner scope', async () => {
    const { input, effective } = await fixture()
    const configured = prepareWebOwnerProfile(input, '[]', effective).patch
    const doc = parseDocument(configured)
    const rows = doc.toJS() as Array<{ id: string }>
    const i = rows.findIndex(row => row.id === 'dsh-enhanced-personal-assistant')
    doc.addIn([i, 'config', 'assistantPolicy', 'rules'], { id: 'custom-deny', effect: 'deny' })
    const custom = doc.toString()
    expect(prepareWebOwnerProfile(input, custom, custom).patch).toContain('custom-deny')
    expect(() => prepareWebOwnerProfile({ ...input, workspace: join(input.dshHome, 'other') }, configured, configured)).toThrow('scope')
    doc.setIn([i, 'config', 'assistantPolicy', 'rules', 1, 'effect'], 'deny')
    expect(() => prepareWebOwnerProfile(input, doc.toString(), configured)).toThrow('customized')
  })
  test('rejects duplicate, missing or disabled bundles before writing or pairing', async () => {
    const { input, effective, path } = await fixture()
    await expect(configureWebOwner(input, effective + '\n- id: dsh-enhanced-assistant-goals\n')).rejects.toThrow('duplicate')
    await expect(configureWebOwner(input, '[]')).rejects.toThrow('install')
    const disabled = effective.replace('id: dsh-enhanced-assistant-goals', 'id: dsh-enhanced-assistant-goals\n  disabled: true')
    await expect(configureWebOwner(input, disabled)).rejects.toThrow('disabled')
    expect(await readFile(path, 'utf8').catch(() => undefined)).toBeUndefined()
  })
  test('does not evaluate arbitrary tagged database expressions', async () => {
    const { input, effective } = await fixture()
    const bad = effective.replace("dshHomePath('assistant-delivery/state.sqlite')", "process.exit(99)")
    expect(() => prepareWebOwnerProfile(input, '[]', bad)).toThrow('literal path')
  })
  test('refuses a second setup lock and symlinked profile patch', async () => {
    const { input, effective, path } = await fixture()
    const lock = join(input.dshHome, 'profiles', input.profile, '.assistant-web-owner-setup.lock')
    await mkdir(lock)
    await expect(configureWebOwner(input, effective)).rejects.toThrow('lock')
    await rm(lock, { recursive: true })
    const other = join(input.dshHome, 'other.yml'); await writeFile(other, '[]')
    await symlink(other, path)
    await expect(configureWebOwner(input, effective)).rejects.toThrow('symlink')
    expect(await readFile(other, 'utf8')).toBe('[]')
  })

  test('scopes inherited global ~/.dsh SQLite defaults for goals, proactive, dreaming, and growth usage under $DSH_HOME without enabling dreaming', async () => {
    const { input, effective } = await fixture()
    const fakeHome = await mkdtemp(join(tmpdir(), 'web-owner-user-home-')); roots.push(fakeHome)
    const fakeDshGlobal = join(fakeHome, '.dsh'); await mkdir(fakeDshGlobal, { recursive: true })
    const withGlobalDefaults = effective
      .replace(
        '- id: dsh-enhanced-assistant-goals\n  name: "@dsh-enhanced/assistant-goals"\n',
        `- id: dsh-enhanced-assistant-goals\n  name: "@dsh-enhanced/assistant-goals"\n  config:\n    databasePath: ${join(fakeDshGlobal, 'assistant-goals.sqlite')}\n`,
      ) + [
      '- id: dsh-enhanced-assistant-proactive',
      '  name: "@dsh-enhanced/assistant-proactive"',
      '  config:',
      `    databasePath: ${join(fakeDshGlobal, 'assistant-proactive.sqlite')}`,
      '- id: dsh-enhanced-assistant-dreaming',
      '  name: "@dsh-enhanced/assistant-dreaming"',
      '  config: {}',
      '- id: dsh-enhanced-assistant-memory-learning',
      '  name: "@dsh-enhanced/assistant-memory-learning"',
      '  disabled: true',
      '  config: {}',
      '- id: dsh-enhanced-assistant-growth-driver',
      '  name: "@dsh-enhanced/assistant-growth-driver"',
      '  config:',
      '    usageLearning:',
      '      enabled: true',
      `      databasePath: ${join(fakeDshGlobal, 'assistant-growth-driver.sqlite')}`,
      '',
    ].join('\n')

    const savedHome = process.env.HOME
    process.env.HOME = fakeHome
    try {
      const plan = prepareWebOwnerProfile(input, '[]', withGlobalDefaults)
      const rows = parseDocument(plan.patch, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (v: string) => v }] }).toJS() as Array<{ id: string; config?: Record<string, any> }>
      const cfg = (id: string) => rows.find(r => r.id === id)?.config
      expect(cfg('dsh-enhanced-assistant-goals')?.databasePath).toBe(join(input.dshHome, 'assistant-goals', 'web.sqlite'))
      expect(cfg('dsh-enhanced-assistant-proactive')?.databasePath).toBe(join(input.dshHome, 'assistant-proactive', 'web.sqlite'))
      expect(cfg('dsh-enhanced-assistant-dreaming')).toEqual({ databasePath: join(input.dshHome, 'assistant-dreaming', 'web.sqlite') })
      expect(cfg('dsh-enhanced-assistant-dreaming')?.enabled).toBeUndefined()
      expect(rows.some(r => r.id === 'dsh-enhanced-assistant-memory-learning')).toBe(false)
      expect(cfg('dsh-enhanced-assistant-growth-driver')?.usageLearning?.databasePath).toBe(join(input.dshHome, 'assistant-growth-driver', 'web-usage.sqlite'))

      // Byte-idempotent on second pass against the configured output.
      expect(prepareWebOwnerProfile(input, plan.patch, plan.patch).patch).toBe(plan.patch)

      // Fails closed if inherited global SQLite state already exists outside $DSH_HOME.
      await writeFile(join(fakeDshGlobal, 'assistant-goals.sqlite'), 'state')
      expect(() => prepareWebOwnerProfile(input, '[]', withGlobalDefaults)).toThrow(/offline migration/u)

      // Fails closed if explicit databasePath escapes $DSH_HOME.
      const escapedPatch = `- id: dsh-enhanced-assistant-proactive\n  config:\n    databasePath: /outside/proactive.sqlite\n`
      expect(() => prepareWebOwnerProfile(input, escapedPatch, withGlobalDefaults.replace(join(fakeDshGlobal, 'assistant-goals.sqlite'), join(input.dshHome, 'goals.sqlite'))))
        .toThrow(/within DSH_HOME/u)
    } finally {
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
    }
  })

  test('dsh-web-owner-setup --help links cleanly with only web-scenario dependencies', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'web-owner-setup-web-only-'))
    try {
      const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
      cpSync(join(packageRoot, 'package.json'), join(tmp, 'package.json'))
      cpSync(join(packageRoot, 'bin'), join(tmp, 'bin'), { recursive: true })
      cpSync(join(packageRoot, 'lib'), join(tmp, 'lib'), { recursive: true })
      const require = createRequire(join(packageRoot, 'package.json'))
      const nodeModules = join(tmp, 'node_modules')
      mkdirSync(join(nodeModules, '@deepseek-ai'), { recursive: true })
      mkdirSync(join(nodeModules, '@dsh-enhanced'), { recursive: true })
      for (const pkg of ['yaml', 'zod', '@deepseek-ai/schemastery', '@dsh-enhanced/assistant-delivery']) {
        symlinkSync(realpathSync(dirname(require.resolve(`${pkg}/package.json`))), join(nodeModules, pkg))
      }
      const stdout = execFileSync(process.execPath, [join(tmp, 'bin', 'dsh-web-owner-setup.js'), '--help'], {
        encoding: 'utf8',
        env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
      })
      expect(stdout).toContain('Usage: dsh-web-owner-setup')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
