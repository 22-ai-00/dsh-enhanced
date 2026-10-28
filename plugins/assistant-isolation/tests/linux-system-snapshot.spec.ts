import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { hashLinuxRuntimeTree, type LinuxRuntime } from '../src/linux-runtime.js'
import { inspectTrustedLinuxSystemSource, linuxSystemSnapshotLimits, parseLinuxSystemElf, prepareLinuxSystemSnapshot, verifyLinuxSystemSnapshot, verifyLinuxSystemSnapshotRuntimeDependencies, type LinuxSystemSnapshot } from '../src/linux-system-snapshot.js'

const directories: string[] = []
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function parent(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-system-snapshot-test-'))
  await chmod(path, 0o700)
  directories.push(path)
  return path
}
async function fixture(link?: string): Promise<LinuxSystemSnapshot> {
  const root = join(await parent(), 'root')
  await mkdir(root, { mode: 0o755 })
  await chmod(root, 0o755)
  await writeFile(join(root, 'tool'), 'trusted bytes', { mode: 0o555 })
  await chmod(join(root, 'tool'), 0o555)
  const origins = [{ path: '/tool', source: '/tool', sourceMode: 0o755, kind: 'file', mode: 0o555, size: 13, sha256: digest('trusted bytes') },
    ...(link ? [{ path: '/alias', source: '/alias', sourceMode: 0o777, kind: 'link', mode: 0o777, sourceTarget: link, target: link }] : [])]
  if (link) await symlink(link, join(root, 'alias'))
  const encoded = JSON.stringify({ schemaVersion: 1, platform: `linux-${process.arch}`, tools: {}, origins }) + '\n'
  await writeFile(join(root, '.dsh-system-manifest.json'), encoded, { mode: 0o444 })
  await chmod(join(root, '.dsh-system-manifest.json'), 0o444)
  const info = await lstat(root)
  return { schemaVersion: 1, root: { path: root, dev: info.dev, ino: info.ino,
    sha256: link?.startsWith('/') || link?.includes('..') ? 'a'.repeat(64) : await hashLinuxRuntimeTree(root) },
  manifestSha256: digest(encoded), bytes: encoded.length + 13, entries: origins.length + 2 }
}

test.runIf(process.platform === 'linux')('snapshot checks inventory, exact immutable modes, relative aliases and actual hashes', async () => {
  const snapshot = await fixture('tool')
  await expect(verifyLinuxSystemSnapshot(snapshot)).resolves.toMatchObject({ entries: 4 })
  await chmod(join(snapshot.root.path, 'tool'), 0o755)
  await expect(verifyLinuxSystemSnapshot(snapshot)).rejects.toThrow('inventory differs')
  await writeFile(join(snapshot.root.path, 'tool'), 'changed bytes')
  await chmod(join(snapshot.root.path, 'tool'), 0o555)
  await expect(verifyLinuxSystemSnapshot(snapshot)).rejects.toThrow('file differs')
})

test.runIf(process.platform === 'linux')('snapshot refuses absolute and escaping aliases', async () => {
  for (const target of ['/etc/passwd', '../outside']) {
    const snapshot = await fixture(target)
    await expect(verifyLinuxSystemSnapshot(snapshot)).rejects.toThrow('link escaped or differs')
  }
})

test.runIf(process.platform === 'linux')('snapshot refuses extra files, replaced manifest and noncanonical metadata', async () => {
  const snapshot = await fixture()
  await writeFile(join(snapshot.root.path, 'extra'), 'unlisted', { mode: 0o444 })
  await expect(verifyLinuxSystemSnapshot(snapshot)).rejects.toThrow('inventory differs')
  await rm(join(snapshot.root.path, 'extra'))
  await expect(verifyLinuxSystemSnapshot({ ...snapshot, bytes: linuxSystemSnapshotLimits.bytes + 1 })).rejects.toThrow('invalid system snapshot')
  await expect(verifyLinuxSystemSnapshot({ ...snapshot, entries: linuxSystemSnapshotLimits.entries + 1 })).rejects.toThrow('invalid system snapshot')
  await expect(verifyLinuxSystemSnapshot({ ...snapshot, root: { ...snapshot.root, ino: snapshot.root.ino + 1 } })).rejects.toThrow('root differs')
  await chmod(join(snapshot.root.path, '.dsh-system-manifest.json'), 0o644)
  await writeFile(join(snapshot.root.path, '.dsh-system-manifest.json'), '{}')
  await chmod(join(snapshot.root.path, '.dsh-system-manifest.json'), 0o444)
  await expect(verifyLinuxSystemSnapshot(snapshot)).rejects.toThrow('manifest differs')
})

test.runIf(process.platform === 'linux')('system source requires root ownership and safe components; alternatives retain their source chain', async () => {
  const path = await parent()
  await writeFile(join(path, 'untrusted'), 'attacker')
  await expect(inspectTrustedLinuxSystemSource(join(path, 'untrusted'))).rejects.toThrow('untrusted system source')
  await expect(inspectTrustedLinuxSystemSource('/dev/null')).rejects.toThrow('special system source')
  await expect(inspectTrustedLinuxSystemSource('/etc/ssl/private')).rejects.toThrow('private system source')
  const source = await inspectTrustedLinuxSystemSource('/usr/bin/awk')
  expect(source.info.uid).toBe(0)
  expect(source.links.map(link => link.path)).toContain('/etc/alternatives/awk')
})

test.runIf(process.platform === 'linux')('preparation rejects public parents and existing destinations without removing their contents', async () => {
  const path = await parent(), root = join(path, 'root')
  await mkdir(root)
  await writeFile(join(root, 'keep'), 'existing')
  await expect(prepareLinuxSystemSnapshot(root)).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(join(root, 'keep'), 'utf8')).toBe('existing')
  await chmod(path, 0o755)
  await expect(prepareLinuxSystemSnapshot(join(path, 'new'))).rejects.toThrow('owner-private')
})

test.runIf(process.platform === 'linux')('abort before or during preparation leaves no partial snapshot', async () => {
  const path = await parent(), controller = new AbortController()
  controller.abort(new Error('pre-aborted'))
  await expect(prepareLinuxSystemSnapshot(join(path, 'before'), controller.signal)).rejects.toThrow('pre-aborted')
  const active = new AbortController()
  const timer = setTimeout(() => active.abort(new Error('cancelled snapshot')), 10)
  try { await expect(prepareLinuxSystemSnapshot(join(path, 'during'), active.signal)).rejects.toThrow('cancelled snapshot') }
  finally { clearTimeout(timer) }
  await expect(lstat(join(path, 'before'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(lstat(join(path, 'during'))).rejects.toMatchObject({ code: 'ENOENT' })
})

function elfFixture(tags: Array<[number, string]>, machine = process.arch === 'x64' ? 62 : 183): Buffer {
  const bytes = Buffer.alloc(1024), strings: number[] = [0], dynamic: Array<[number, number]> = []
  for (const [tag, value] of tags) {
    dynamic.push([tag, strings.length])
    strings.push(...Buffer.from(value), 0)
  }
  bytes.set(Buffer.from('7f454c46', 'hex'))
  bytes[4] = 2; bytes[5] = 1
  bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(machine, 18)
  bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(2, 56)
  bytes.writeUInt32LE(1, 64); bytes.writeBigUInt64LE(1024n, 96)
  bytes.writeUInt32LE(2, 120); bytes.writeBigUInt64LE(176n, 128); bytes.writeBigUInt64LE(128n, 152)
  const records = [[5, 512], [10, strings.length], ...dynamic]
  for (const [i, [tag, value]] of records.entries()) {
    bytes.writeBigInt64LE(BigInt(tag!), 176 + i * 16)
    bytes.writeBigUInt64LE(BigInt(value!), 184 + i * 16)
  }
  bytes.set(strings, 512)
  return bytes
}

test.runIf(process.platform === 'linux')('ELF uses inherited RPATH, direct RUNPATH precedence and normalized ORIGIN without unbounded reads', async () => {
  const inspect = async (bytes: Buffer): Promise<Awaited<ReturnType<typeof parseLinuxSystemElf>>> => {
    return await parseLinuxSystemElf(async (offset, length) => {
      expect(length).toBeLessThanOrEqual(4 * 1024 * 1024)
      return bytes.subarray(offset, offset + length)
    }, bytes.length, '/usr/lib/example/loader.so')
  }
  await expect(inspect(elfFixture([[1, 'libexample.so'], [15, '$ORIGIN/..']]))).resolves.toMatchObject({
    needed: ['libexample.so'], search: ['/usr/lib'], inherit: true,
  })
  await expect(inspect(elfFixture([[15, '/lib'], [29, '${ORIGIN}/..']]))).resolves.toMatchObject({
    search: ['/usr/lib'], inherit: false,
  })
  for (const directory of ['/tmp/controlled', '/run/controlled', '/workspace/lib', '/home/lib', '/usr/lib/dsh-nonexistent-search']) {
    await expect(inspect(elfFixture([[15, directory]]))).rejects.toThrow('unsafe ELF search directory')
    await expect(inspect(elfFixture([[15, directory], [29, '/usr/lib']]))).rejects.toThrow('unsafe ELF search directory')
  }
  for (const tag of [15, 29]) {
    await expect(inspect(elfFixture([[tag, '/usr/lib'], [tag, '/tmp/controlled']]))).rejects.toThrow('duplicate ELF dynamic metadata')
  }
  await expect(inspect(elfFixture([[15, '$LIB/unsupported']]))).rejects.toThrow('unsupported ELF search')
  await expect(inspect(elfFixture([], 0))).rejects.toThrow('unsupported system ELF')
  const oversized = elfFixture([])
  oversized.writeBigUInt64LE(8n * 1024n * 1024n, 152)
  await expect(inspect(oversized)).rejects.toThrow('metadata bound exceeded')
})

test.runIf(process.platform === 'linux')('actual sparse file over the byte bound is rejected before reading its content', async () => {
  const snapshot = await fixture(), path = join(snapshot.root.path, 'tool')
  await chmod(path, 0o755)
  await truncate(path, linuxSystemSnapshotLimits.bytes + 1)
  await chmod(path, 0o555)
  const manifestPath = join(snapshot.root.path, '.dsh-system-manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { origins: Array<{ size: number }> }
  manifest.origins[0]!.size = linuxSystemSnapshotLimits.bytes + 1
  const encoded = JSON.stringify(manifest) + '\n'
  await chmod(manifestPath, 0o644)
  await writeFile(manifestPath, encoded)
  await chmod(manifestPath, 0o444)
  await expect(verifyLinuxSystemSnapshot({ ...snapshot, bytes: linuxSystemSnapshotLimits.bytes,
    manifestSha256: digest(encoded) })).rejects.toThrow('file differs')
})

const abiRuntime = process.env.DSH_TEST_LINUX_ABI_RUNTIME_JSON
const abiMissing = process.env.DSH_TEST_LINUX_ABI_MISSING_SNAPSHOT_JSON
test.runIf(process.platform === 'linux' && Boolean(abiRuntime && abiMissing))('fixed external Node and native pnpm require complete immutable system ABI closure', async () => {
  const prepared = JSON.parse(await readFile(abiRuntime!, 'utf8')) as { environment: { runtime: LinuxRuntime; systemSnapshot: LinuxSystemSnapshot } }
  const missing = JSON.parse(await readFile(abiMissing!, 'utf8')) as { snapshot: LinuxSystemSnapshot }
  await expect(verifyLinuxSystemSnapshotRuntimeDependencies(missing.snapshot, prepared.environment.runtime)).rejects.toThrow('missing runtime system dependency: libdl.so.2')
  await expect(verifyLinuxSystemSnapshotRuntimeDependencies(prepared.environment.systemSnapshot, prepared.environment.runtime)).resolves.toBeUndefined()
  const manifest = JSON.parse(await readFile(join(prepared.environment.systemSnapshot.root.path, '.dsh-system-manifest.json'), 'utf8')) as { origins: Array<{ path: string; kind: string; sha256: string; pinnedNodeRuntimeDigest?: string }> }
  for (const tool of ['sha256sum', 'yes', 'printenv', 'ls']) {
    expect(manifest.origins.find(origin => origin.path === `/usr/bin/${tool}`)).toMatchObject({
      kind: 'file', source: `/usr/bin/${tool}`,
    })
  }
  for (const [alias, target] of [['openssl.cnf', 'etc/ssl/openssl.cnf'], ['certs', 'etc/ssl/certs'],
    ['cert.pem', 'etc/ssl/certs/ca-certificates.crt']] as const) {
    expect(await realpath(join(prepared.environment.systemSnapshot.root.path, 'usr/lib/ssl', alias)))
      .toBe(await realpath(join(prepared.environment.systemSnapshot.root.path, target)))
  }
  for (const privatePath of ['etc/ssl/private', 'usr/lib/ssl/private']) {
    await expect(lstat(join(prepared.environment.systemSnapshot.root.path, privatePath))).rejects.toMatchObject({ code: 'ENOENT' })
  }
  expect(manifest.origins.find(origin => origin.path === '/usr/bin/node')).toMatchObject({
    kind: 'pinned-runtime-node', sha256: prepared.environment.runtime.nodeSha256, pinnedNodeRuntimeDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
  })
  const noAlias = process.env.DSH_TEST_LINUX_ABI_NO_NODE_SNAPSHOT_JSON
  if (noAlias) {
    const snapshot = JSON.parse(await readFile(noAlias, 'utf8')) as { snapshot: LinuxSystemSnapshot }
    await expect(verifyLinuxSystemSnapshotRuntimeDependencies(snapshot.snapshot, prepared.environment.runtime)).rejects.toThrow('pinned runtime Node provenance differs')
  }
  await expect(verifyLinuxSystemSnapshotRuntimeDependencies(prepared.environment.systemSnapshot,
    { ...prepared.environment.runtime, sourceCommit: 'f'.repeat(40) })).rejects.toThrow('pinned runtime Node provenance differs')
  await expect(verifyLinuxSystemSnapshotRuntimeDependencies(prepared.environment.systemSnapshot,
    { ...prepared.environment.runtime, nodePath: '/usr/bin/node' })).rejects.toThrow('invalid Linux runtime')
}, 120000)
