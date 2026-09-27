import { sign, verify } from 'node:crypto'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { prepareRsiAuthorityResources, rsiAuthorityRoles } from '../src/rsi-authority-resources.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'rsi-authority-resources-')); roots.push(home)
  return { home, input: { dshHome: home, profile: 'owner' } }
}

describe('private authority identities and local release storage', () => {
  test('creates fourteen distinct Ed25519 identities once and preserves published catalog and authority state', async () => {
    const f = await fixture(), first = await prepareRsiAuthorityResources(f.input)
    expect(new Set(Object.values(first.identities).map(value => value.publicKeyPem)).size).toBe(14)
    const keys = new Map<string, { bytes: Buffer; ino: number }>()
    const message = Buffer.from('independent authority identity')
    for (const role of rsiAuthorityRoles) {
      const identity = first.identities[role], bytes = await readFile(identity.keyPath), entry = await lstat(identity.keyPath)
      expect(entry.mode & 0o777).toBe(0o600); expect(entry.nlink).toBe(1)
      expect(verify(null, message, identity.publicKeyPem, sign(null, message, bytes))).toBe(true)
      keys.set(role, { bytes, ino: entry.ino })
    }
    for (const path of [first.root, first.stateRoot, first.configRoot, first.registry.root]) expect((await lstat(path)).mode & 0o777).toBe(0o700)
    const catalog = { schemaVersion: 1, entries: [{ id: 'fixture', package: '@dsh-enhanced/fixture', version: '1.2.3',
      integrity: 'sha512-Zml4dHVyZQ==', capabilities: ['fixture'], authorities: ['owner'], requires: [], dshBaseline: '0.1.5-rc.3' }] }
    await writeFile(first.catalog.path, JSON.stringify(catalog), { mode: 0o600 })
    await writeFile(join(first.registry.root, 'published.tgz'), 'published artifact', { mode: 0o600 })
    await writeFile(join(first.stateRoot, 'state.sqlite'), 'existing authority state', { mode: 0o600 })
    await writeFile(join(first.configRoot, 'grant.json'), '{"existing":"grant"}', { mode: 0o600 })
    expect(await prepareRsiAuthorityResources(f.input)).toEqual(first)
    expect(JSON.parse(await readFile(first.catalog.path, 'utf8'))).toEqual(catalog)
    expect(await readFile(join(first.registry.root, 'published.tgz'), 'utf8')).toBe('published artifact')
    expect(await readFile(join(first.stateRoot, 'state.sqlite'), 'utf8')).toBe('existing authority state')
    expect(await readFile(join(first.configRoot, 'grant.json'), 'utf8')).toBe('{"existing":"grant"}')
    for (const role of rsiAuthorityRoles) {
      expect(await readFile(first.identities[role].keyPath)).toEqual(keys.get(role)!.bytes)
      expect((await lstat(first.identities[role].keyPath)).ino).toBe(keys.get(role)!.ino)
    }
    expect(JSON.stringify(first)).not.toContain('PRIVATE KEY')
  })
  test.each(['key-content', 'key-permissions', 'key-link', 'missing-key', 'catalog', 'registry-link', 'receipt'] as const)(
    'rejects %s drift without regenerating identities or discarding evidence', async kind => {
      const f = await fixture(), first = await prepareRsiAuthorityResources(f.input)
      const key = first.identities.approval.keyPath
      if (kind === 'key-content') await writeFile(key, await readFile(first.identities.release.keyPath))
      if (kind === 'key-permissions') await chmod(key, 0o644)
      if (kind === 'key-link') await link(key, join(f.home, 'linked.pem'))
      if (kind === 'missing-key') await unlink(key)
      if (kind === 'catalog') await writeFile(first.catalog.path, '{')
      if (kind === 'registry-link') { await rm(first.registry.root, { recursive: true }); await symlink(f.home, first.registry.root) }
      const receipt = join(first.root, 'bootstrap.json')
      if (kind === 'receipt') await writeFile(receipt, (await readFile(receipt, 'utf8')).replace('registry-', 'changed-'))
      const unchanged = await readFile(first.identities.host.keyPath), originalReceipt = await readFile(receipt)
      await expect(prepareRsiAuthorityResources(f.input)).rejects.toThrow()
      expect(await readFile(first.identities.host.keyPath)).toEqual(unchanged)
      expect(await readFile(receipt)).toEqual(originalReceipt)
    },
  )
  test('rejects cancellation and incomplete prior resources instead of replacing them', async () => {
    const f = await fixture(), controller = new AbortController(); controller.abort(new Error('cancelled'))
    await expect(prepareRsiAuthorityResources({ ...f.input, signal: controller.signal })).rejects.toThrow('cancelled')
    await expect(lstat(join(f.home, 'rsi-authorities'))).rejects.toMatchObject({ code: 'ENOENT' })
    const root = join(f.home, 'rsi-authorities', 'owner')
    await mkdir(root, { recursive: true, mode: 0o700 }); await writeFile(join(root, 'keep'), 'incomplete')
    await expect(prepareRsiAuthorityResources(f.input)).rejects.toThrow('incomplete')
    expect(await readFile(join(root, 'keep'), 'utf8')).toBe('incomplete')
  })
})
