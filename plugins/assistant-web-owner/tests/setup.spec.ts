import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
})
