import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { ensureLarkBusinessCli } from '../src/business-cli-install.ts'

const originalPath = process.env.PATH
const roots: string[] = []
const version = '1.0.96'
const archiveName = `lark-cli-${version}-linux-amd64.tar.gz`
const registryUrl = 'https://registry.npmjs.org/@larksuite%2fcli/latest'
const tarballUrl = `https://registry.npmjs.org/@larksuite/cli/-/cli-${version}.tgz`
const releaseUrl = `https://github.com/larksuite/cli/releases/download/v${version}/${archiveName}`
const mirrorUrl = `https://registry.npmmirror.com/-/binary/lark-cli/v${version}/${archiveName}`

afterEach(async () => {
  process.env.PATH = originalPath
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-business-cli-'))
  roots.push(root)
  const home = join(root, 'dsh-home')
  const bin = join(root, 'fake-bin')
  await mkdir(bin)
  process.env.PATH = `${bin}:/usr/bin:/bin`
  return { root, home, bin }
}

async function writeCli(path: string, reportedVersion = version) {
  await writeFile(path, `#!/bin/sh
case "$*" in
  '--version') printf 'lark-cli version ${reportedVersion}\\n' ;;
  'config init --help') printf '%s\\n' 'config init --app-secret-stdin --name' ;;
  'auth login --help') printf '%s\\n' 'auth login --domain all' ;;
  'skills list --help') printf '%s\\n' 'skills list' ;;
  'skills read --help') printf '%s\\n' 'skills read' ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 })
  await chmod(path, 0o755)
}

async function registryFixture(root: string, binaryVersion = version) {
  const releaseDir = join(root, 'release')
  const packageDir = join(root, 'npm', 'package')
  await mkdir(releaseDir, { recursive: true })
  await mkdir(packageDir, { recursive: true })
  await writeCli(join(releaseDir, 'lark-cli'), binaryVersion)
  const releaseArchive = join(root, archiveName)
  const releaseTar = spawnSync('/usr/bin/tar', ['-czf', releaseArchive, '-C', releaseDir, 'lark-cli'])
  expect(releaseTar.status).toBe(0)
  const releaseBytes = await readFile(releaseArchive)
  const releaseSha256 = createHash('sha256').update(releaseBytes).digest('hex')
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@larksuite/cli', version }))
  await writeFile(join(packageDir, 'checksums.txt'), `${releaseSha256}  ${archiveName}\n`)
  const packageArchive = join(root, 'cli.tgz')
  const packageTar = spawnSync('/usr/bin/tar', ['-czf', packageArchive, '-C', join(root, 'npm'), 'package'])
  expect(packageTar.status).toBe(0)
  const packageBytes = await readFile(packageArchive)
  const integrity = `sha512-${createHash('sha512').update(packageBytes).digest('base64')}`
  const metadata = { version, dist: { tarball: tarballUrl, integrity } }
  const requests: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input)
    requests.push(url)
    if (url === registryUrl) return new Response(JSON.stringify(metadata), { status: 200 })
    if (url === tarballUrl) return new Response(packageBytes, { status: 200 })
    if (url === releaseUrl) return new Response(releaseBytes, { status: 200 })
    return new Response('', { status: 404 })
  })
  return { metadata, requests, packageBytes, releaseBytes }
}

test('reuses a PATH CLI only after version and required command contracts pass', async () => {
  const f = await fixture()
  const command = join(f.bin, 'lark-cli')
  await writeCli(command, '1.0.85')
  vi.stubGlobal('fetch', () => { throw new Error('registry must not be queried') })
  expect(await ensureLarkBusinessCli({ dshHome: f.home })).toEqual({ command, version: '1.0.85' })
  expect(existsSync(f.home)).toBe(false)
})

test('does not trust help-only CLI releases older than the verified auth contract', async () => {
  const f = await fixture()
  const old = join(f.bin, 'lark-cli')
  await writeCli(old, '1.0.84')
  const registry = await registryFixture(f.root)
  const result = await ensureLarkBusinessCli({ dshHome: f.home })
  expect(result.version).toBe(version)
  expect(result.command).not.toBe(old)
  expect(registry.requests).toEqual([registryUrl, tarballUrl, releaseUrl])
  await expect(ensureLarkBusinessCli({ dshHome: f.home, command: old }))
    .rejects.toThrow('does not satisfy the required command contract')
})

test('installs the exact official release in DSH_HOME when PATH CLI lacks the contract', async () => {
  const f = await fixture()
  await writeFile(join(f.bin, 'lark-cli'), '#!/bin/sh\necho obsolete\n', { mode: 0o755 })
  const registry = await registryFixture(f.root)
  const result = await ensureLarkBusinessCli({ dshHome: f.home })
  expect(result.version).toBe(version)
  expect(result.command).toBe(join(f.home, '.dsh-enhanced', 'tools', 'lark-cli', version,
    `${process.platform}-${process.arch}`, 'lark-cli'))
  expect(registry.requests).toEqual([registryUrl, tarballUrl, releaseUrl])
  const provenance = JSON.parse(await readFile(join(result.command, '..', 'provenance.json'), 'utf8')) as Record<string, string>
  expect(provenance.version).toBe(version)
  expect(provenance.npmIntegrity).toBe(registry.metadata.dist.integrity)
  expect(await readFile(join(f.bin, 'lark-cli'), 'utf8')).toContain('obsolete')
  vi.stubGlobal('fetch', () => { throw new Error('offline registry must not be queried') })
  expect(await ensureLarkBusinessCli({ dshHome: f.home })).toEqual(result)
  expect(registry.requests).toEqual([registryUrl, tarballUrl, releaseUrl])
})

test('rejects an invalid npm archive without replacing an older managed CLI', async () => {
  const f = await fixture()
  const oldCommand = join(f.home, '.dsh-enhanced', 'tools', 'lark-cli', '1.0.95',
    `${process.platform}-${process.arch}`, 'lark-cli')
  await mkdir(join(oldCommand, '..'), { recursive: true })
  await writeCli(oldCommand, '1.0.95')
  const registry = await registryFixture(f.root)
  registry.metadata.dist.integrity = `sha512-${'A'.repeat(86)}==`
  await expect(ensureLarkBusinessCli({ dshHome: f.home })).rejects.toThrow('integrity mismatch')
  expect(await readFile(oldCommand, 'utf8')).toContain('1.0.95')
  expect(existsSync(join(f.home, '.dsh-enhanced', 'tools', 'lark-cli', version))).toBe(false)
  expect(registry.requests).toEqual([registryUrl, tarballUrl])
})

test('rejects a release binary whose SHA-256 differs from the official package checksum', async () => {
  const f = await fixture()
  const registry = await registryFixture(f.root)
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input)
    if (url === registryUrl) return new Response(JSON.stringify(registry.metadata), { status: 200 })
    if (url === tarballUrl) return new Response(registry.packageBytes, { status: 200 })
    if (url === releaseUrl || url === mirrorUrl) return new Response(Buffer.from('tampered release'), { status: 200 })
    return new Response('', { status: 404 })
  })
  await expect(ensureLarkBusinessCli({ dshHome: f.home })).rejects.toThrow('checksum mismatch')
  expect(existsSync(join(f.home, '.dsh-enhanced', 'tools', 'lark-cli', version))).toBe(false)
})

test('falls back to the official installer mirror when GitHub is unavailable', async () => {
  const f = await fixture()
  const registry = await registryFixture(f.root)
  const requests: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input)
    requests.push(url)
    if (url === registryUrl) return new Response(JSON.stringify(registry.metadata), { status: 200 })
    if (url === tarballUrl) return new Response(registry.packageBytes, { status: 200 })
    if (url === releaseUrl) throw new Error('GitHub unavailable')
    if (url === mirrorUrl) return new Response(registry.releaseBytes, { status: 200 })
    return new Response('', { status: 404 })
  })
  const result = await ensureLarkBusinessCli({ dshHome: f.home })
  expect(result.version).toBe(version)
  expect(requests).toEqual([registryUrl, tarballUrl, releaseUrl, mirrorUrl])
})

test('rejects a checksummed binary that does not report the exact selected version', async () => {
  const f = await fixture()
  await registryFixture(f.root, '1.0.95')
  await expect(ensureLarkBusinessCli({ dshHome: f.home })).rejects.toThrow('contract verification')
  expect(existsSync(join(f.home, '.dsh-enhanced', 'tools', 'lark-cli', version))).toBe(false)
})

test('an explicit unusable command fails without any registry or managed writes', async () => {
  const f = await fixture()
  vi.stubGlobal('fetch', () => { throw new Error('registry must not be queried') })
  await expect(ensureLarkBusinessCli({ dshHome: f.home, command: join(f.bin, 'missing') }))
    .rejects.toThrow('not an executable')
  expect(existsSync(f.home)).toBe(false)
})

test('ignores symlinked managed version candidates instead of reading or running outside files', async () => {
  const f = await fixture()
  const toolsRoot = join(f.home, '.dsh-enhanced', 'tools', 'lark-cli')
  const external = join(f.root, 'external-version')
  await mkdir(external)
  await mkdir(toolsRoot, { recursive: true })
  await symlink(external, join(toolsRoot, version), 'dir')
  await writeFile(join(external, 'untouched'), 'owner data')
  vi.stubGlobal('fetch', () => { throw new Error('offline registry') })
  await expect(ensureLarkBusinessCli({ dshHome: f.home })).rejects.toThrow('offline registry')
  expect(await readFile(join(external, 'untouched'), 'utf8')).toBe('owner data')
})
