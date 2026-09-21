import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ActiveLarkOwnerBindingsSnapshot } from '@dsh-enhanced/assistant-delivery'
import { assertRsiEffectivePatch, configureRsiSetup, parseRsiSetupArgs, type RsiSetupPorts } from '../src/rsi-setup.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-rsi-setup-')); roots.push(home)
  const pair = ['target', 'coordinator']
  for (const name of pair) {
    await mkdir(join(home, 'profiles', name), { recursive: true, mode: 0o700 })
    await writeFile(join(home, 'profiles', name, 'cordis.patch.yml'), `- id: ${name}\n  config: { status: original }\n`, { mode: 0o600 })
  }
  const manifestPath = join(home, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, targetProfile: pair[0], coordinatorProfile: pair[1] }), { mode: 0o600 })
  // These ports isolate the OS/DSH and compiler contracts; journal and flock are real.
  const snapshot = { bindings: [{ owner: { id: 'owner', version: 1 } }], snapshotDigest: 'unchanged' } as unknown as ActiveLarkOwnerBindingsSnapshot
  const ports: RsiSetupPorts = {
    dump: vi.fn(profile => readFileSync(join(home, 'profiles', profile, 'cordis.patch.yml'), 'utf8')),
    base: vi.fn(async () => '[]\n'),
    snapshot: vi.fn(async () => snapshot),
    compile: vi.fn(async () => ({ targetPatch: '- id: target\n  config: { status: configured }\n', coordinatorPatch: '- id: coordinator\n  config: { status: configured }\n' })),
    validateAuthorities: vi.fn(async () => {}), assertStopped: vi.fn(), start: vi.fn(async () => {}),
  }
  const args = (flags: string[] = []) => parseRsiSetupArgs(['--manifest', manifestPath, '--dsh-home', home, ...flags])
  const apply = ['--apply', '--confirm-hosts-stopped']
  const rollback = ['--rollback', '--confirm-hosts-stopped']
  const patch = (profile = pair[0]!) => join(home, 'profiles', profile, 'cordis.patch.yml')
  const journal = join(home, '.rsi-setup-journal.json')
  return { home, pair, manifestPath, ports, args, apply, rollback, patch, journal }
}

describe('RSI dual profile setup transaction', () => {
  test('final composition compares values and executable YAML tags, ignoring formatting', () => {
    const patch = '- id: managed\n  config: { count: 1, path: !!js dshHomePath("state") }\n'
    expect(() => assertRsiEffectivePatch(patch, '- id: managed\n  config:\n    path: !!js dshHomePath("state")\n    count: 1\n')).not.toThrow()
    expect(() => assertRsiEffectivePatch(patch, patch.replace('count: 1', 'count: 2'))).toThrow('overrides compiled config')
    expect(() => assertRsiEffectivePatch(patch, patch.replace('!!js ', ''))).toThrow('overrides compiled config')
    expect(() => assertRsiEffectivePatch(patch, '[]')).toThrow('overrides compiled config')
  })
  test('default validates without writing or starting services', async () => {
    const f = await fixture()
    expect(await configureRsiSetup(f.args(), f.ports)).toEqual({ mode: 'checked', profiles: f.pair })
    expect(await readFile(f.patch(), 'utf8')).toBe('- id: target\n  config: { status: original }\n')
    await expect(stat(f.journal)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.ports.validateAuthorities).toHaveBeenCalledOnce()
    expect(f.ports.start).not.toHaveBeenCalled()
  })
  test('applies both profiles, retains private journal across idempotent apply, and rolls back', async () => {
    const f = await fixture()
    await configureRsiSetup(f.args(f.apply), f.ports)
    const journal = await readFile(f.journal, 'utf8')
    expect((await stat(f.journal)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(journal).stage).toBe('applied')
    expect(await readFile(f.patch('coordinator'), 'utf8')).toBe('- id: coordinator\n  config: { status: configured }\n')
    await configureRsiSetup(f.args(f.apply), f.ports)
    expect(await readFile(f.journal, 'utf8')).toBe(journal)
    // Restoration remains possible when forward authorities expire.
    f.ports.validateAuthorities = vi.fn(async () => { throw new Error('expired') })
    expect((await configureRsiSetup(f.args(f.rollback), f.ports)).mode).toBe('rolled-back')
    expect(await readFile(f.patch(), 'utf8')).toBe('- id: target\n  config: { status: original }\n')
    expect(await readFile(f.patch('coordinator'), 'utf8')).toBe('- id: coordinator\n  config: { status: original }\n')
  })
  test('failed final DSH composition restores both originals', async () => {
    const f = await fixture()
    let count = 0
    f.ports.dump = vi.fn(() => { if (++count > 2) throw new Error('compose failed'); return 'initial' })
    await expect(configureRsiSetup(f.args(f.apply), f.ports)).rejects.toThrow('compose failed')
    expect(await readFile(f.patch(), 'utf8')).toBe('- id: target\n  config: { status: original }\n')
    expect(await readFile(f.patch('coordinator'), 'utf8')).toBe('- id: coordinator\n  config: { status: original }\n')
    await expect(stat(f.journal)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  test('later failed apply preserves the previous rollback point', async () => {
    const f = await fixture()
    await configureRsiSetup(f.args(f.apply), f.ports)
    const previous = await readFile(f.journal, 'utf8')
    f.ports.compile = vi.fn(async () => ({ targetPatch: '- id: target\n  config: { status: next }\n', coordinatorPatch: '- id: coordinator\n  config: { status: next }\n' }))
    let count = 0
    f.ports.dump = vi.fn(profile => {
      if (++count > 2) throw new Error('compose failed')
      return readFileSync(f.patch(profile), 'utf8')
    })
    await expect(configureRsiSetup(f.args(f.apply), f.ports)).rejects.toThrow('compose failed')
    expect(await readFile(f.journal, 'utf8')).toBe(previous)
    await configureRsiSetup(f.args(f.rollback), f.ports)
    expect(await readFile(f.patch(), 'utf8')).toBe('- id: target\n  config: { status: original }\n')
  })
  test('final higher-layer override fails and restores both profiles', async () => {
    const f = await fixture()
    let count = 0
    f.ports.dump = vi.fn(profile => {
      const actual = readFileSync(f.patch(profile), 'utf8')
      return ++count > 2 ? actual.replace('configured', 'overridden') : actual
    })
    await expect(configureRsiSetup(f.args(f.apply), f.ports)).rejects.toThrow('overrides compiled config')
    expect(await readFile(f.patch(), 'utf8')).toBe('- id: target\n  config: { status: original }\n')
  })
  test('interrupted transaction blocks new apply; rollback accepts half-restored pair', async () => {
    const f = await fixture()
    await configureRsiSetup(f.args(f.apply), f.ports)
    const journal = JSON.parse(await readFile(f.journal, 'utf8')); journal.stage = 'prepared'
    await writeFile(f.journal, JSON.stringify(journal))
    await expect(configureRsiSetup(f.args(f.apply), f.ports)).rejects.toThrow('interrupted setup')
    await writeFile(f.patch(), '- id: target\n  config: { status: original }\n')
    await configureRsiSetup(f.args(f.rollback), f.ports)
    expect(await readFile(f.patch('coordinator'), 'utf8')).toBe('- id: coordinator\n  config: { status: original }\n')
  })
  test('rollback checks both profiles before restoring either', async () => {
    const f = await fixture()
    await configureRsiSetup(f.args(f.apply), f.ports)
    await writeFile(f.patch('coordinator'), 'external edit\n')
    await expect(configureRsiSetup(f.args(f.rollback), f.ports)).rejects.toThrow('changed outside setup')
    expect(await readFile(f.patch(), 'utf8')).toBe('- id: target\n  config: { status: configured }\n')
    expect((await stat(f.journal)).isFile()).toBe(true)
  })
  test('active service prevents any profile write', async () => {
    const f = await fixture()
    f.ports.assertStopped = vi.fn(() => { throw new Error('active') })
    await expect(configureRsiSetup(f.args(f.apply), f.ports)).rejects.toThrow('active')
    expect(f.ports.compile).not.toHaveBeenCalled()
    expect(await readFile(f.patch(), 'utf8')).toBe('- id: target\n  config: { status: original }\n')
  })
  test.each(['owner', 'manifest', 'patch'])('rejects changed %s before write', async change => {
    const f = await fixture()
    const original = f.ports.compile
    f.ports.compile = vi.fn(async input => {
      if (change === 'owner') f.ports.snapshot = vi.fn(async () => ({ bindings: [] }) as unknown as ActiveLarkOwnerBindingsSnapshot)
      if (change === 'manifest') await writeFile(f.manifestPath, '{}')
      if (change === 'patch') await writeFile(f.patch(), 'external edit\n')
      return original(input)
    })
    await expect(configureRsiSetup(f.args(f.apply), f.ports)).rejects.toThrow('changed before write')
    await expect(stat(f.journal)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(f.patch('coordinator'), 'utf8')).toBe('- id: coordinator\n  config: { status: original }\n')
  })
  test('starts coordinator before target; failed target start retains applied configuration', async () => {
    const f = await fixture()
    const started: string[] = []
    f.ports.start = vi.fn(async profile => { started.push(profile); if (profile === 'target') throw new Error('target start failed') })
    await expect(configureRsiSetup(f.args([...f.apply, '--start']), f.ports)).rejects.toThrow('target start failed')
    expect(started).toEqual(['coordinator', 'target'])
    expect(await readFile(f.patch(), 'utf8')).toBe('- id: target\n  config: { status: configured }\n')
    expect(JSON.parse(await readFile(f.journal, 'utf8')).stage).toBe('applied')
  })
  test('rejects symlink and publicly readable private manifest', async () => {
    const f = await fixture()
    await chmod(f.manifestPath, 0o644)
    await expect(configureRsiSetup(f.args(), f.ports)).rejects.toThrow('unsafe file')
    await chmod(f.manifestPath, 0o600)
    const link = join(f.home, 'linked.json'); await symlink(f.manifestPath, link)
    await expect(configureRsiSetup({ ...f.args(), manifestPath: link }, f.ports)).rejects.toThrow('noncanonical file')
  })
  test('argument parser refuses implicit mutation and incompatible operations', () => {
    const base = ['--manifest', '/tmp/private.json', '--dsh-home', '/tmp/home']
    expect(() => parseRsiSetupArgs([...base, '--start'])).toThrow('requires --apply')
    expect(() => parseRsiSetupArgs([...base, '--apply'])).toThrow('confirm-hosts-stopped')
    expect(() => parseRsiSetupArgs([...base, '--rollback', '--apply'])).toThrow('cannot be combined')
    expect(() => parseRsiSetupArgs([...base, '--apply', '--apply'])).toThrow('duplicate')
  })
})
