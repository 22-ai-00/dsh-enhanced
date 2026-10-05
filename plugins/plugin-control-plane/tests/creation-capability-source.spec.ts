import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { afterEach, expect, test } from 'vitest'
import { captureCreationCapabilitySource, creationCapabilitySourceDigest, validateCreationCapabilitySource,
  type CreationCapabilitySourceSnapshot } from '../src/creation-capability-source.js'
import { checkedSourceSnapshot } from '../src/source-workspace.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'created-source-'))
  roots.push(root)
  git(root, 'init', '-q')
  git(root, 'config', 'user.name', 'Source Test')
  git(root, 'config', 'user.email', 'source@example.invalid')
  mkdirSync(join(root, 'plugins'))
  writeFileSync(join(root, 'plugins/README.md'), 'catalog\n')
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  writeFileSync(join(root, '.gitattributes'), '*.txt text eol=lf\n*.filter filter=source-clean\n')
  git(root, 'config', 'filter.source-clean.clean', 'tr A-Z a-z')
  writeFileSync(join(root, '.gitignore'), 'plugins/generated-demo/ignored.txt\n')
  git(root, 'add', '--all')
  git(root, 'commit', '-qm', 'base')
  const baseCommit = git(root, 'rev-parse', 'HEAD')
  const plugin = join(root, 'plugins/generated-demo')
  mkdirSync(join(plugin, 'src'), { recursive: true })
  writeFileSync(join(plugin, 'README.md'), Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('New plugin\n')]))
  writeFileSync(join(plugin, 'src/index.ts'), 'export const tool = 1\n')
  writeFileSync(join(plugin, 'src/line.txt'), 'FIRST\r\nSECOND\r\n')
  writeFileSync(join(plugin, 'src/staged.filter'), 'STAGED BY FILTER\n')
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ scripts: {
    prepack: 'node -e "require(\'fs\').writeFileSync(\'package-script-ran\',\'yes\')"',
  } }))
  writeFileSync(join(root, 'plugins/README.md'), 'catalog\ngenerated-demo\n')
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\nimporters:\n  generated-demo: {}\n')
  const scope = ['plugins/README.md', 'plugins/generated-demo', 'pnpm-lock.yaml']
  async function certificate(): Promise<PluginCreationVerificationCertificate> {
    const checked = await checkedSourceSnapshot(root, baseCommit, scope, process.env)
    return { plan: { id: 'plan', digest: 'a'.repeat(64), name: 'generated-demo',
      sourceTreeDigest: checked.checkedTreeDigest, sourcePatchDigest: checked.checkedPatchDigest,
      artifactSha256: 'b'.repeat(64), artifactBytes: 1, generatorDigest: 'c'.repeat(64) } } as PluginCreationVerificationCertificate
  }
  return { root, plugin, baseCommit, scope, certificate }
}

async function captured(f: ReturnType<typeof fixture>): Promise<{ certificate: PluginCreationVerificationCertificate;
  snapshot: CreationCapabilitySourceSnapshot }> {
  const certificate = await f.certificate()
  const snapshot = await captureCreationCapabilitySource({ worktree: f.root, baseCommit: f.baseCommit,
    scope: f.scope, certificate, environment: process.env })
  return { certificate, snapshot }
}

test('archives staged Git blob bytes, including BOM and CRLF normalization, then validates offline', async () => {
  const f = fixture()
  const { certificate, snapshot } = await captured(f)
  expect(snapshot.files.find(file => file.path.endsWith('/README.md'))?.content.charCodeAt(0)).toBe(0xfeff)
  const line = snapshot.files.find(file => file.path.endsWith('/src/line.txt'))!
  expect(readFileSync(join(f.plugin, 'src/line.txt'), 'utf8')).toBe('FIRST\r\nSECOND\r\n')
  expect(line.content).toBe('FIRST\nSECOND\n')
  expect(snapshot.files.find(file => file.path.endsWith('/src/staged.filter'))?.content).toBe('staged by filter\n')
  expect(snapshot.entries.map(entry => entry.path)).toContain('pnpm-lock.yaml')
  expect(snapshot.files.some(file => file.path === 'pnpm-lock.yaml')).toBe(false)
  expect(existsSync(join(f.root, 'package-script-ran'))).toBe(false)
  expect(git(f.root, 'ls-files', 'plugins/generated-demo')).toBe('')
  rmSync(f.root, { recursive: true, force: true })
  expect(() => validateCreationCapabilitySource(JSON.parse(JSON.stringify(snapshot)), certificate)).not.toThrow()
})

test('rejects changed tree and changed patch against the checked certificate', async () => {
  const f = fixture()
  const certificate = await f.certificate()
  writeFileSync(join(f.plugin, 'src/index.ts'), 'export const tool = 2\n')
  await expect(captureCreationCapabilitySource({ worktree: f.root, baseCommit: f.baseCommit, scope: f.scope,
    certificate, environment: process.env })).rejects.toThrow('certificate digest')
  const fresh = await captured(f)
  const bad = { ...fresh.snapshot, patchDigest: 'f'.repeat(64) }
  expect(() => validateCreationCapabilitySource(bad, fresh.certificate)).toThrow('certificate digest')
})

test('rejects ignored extras, symlinks and oversized plugin files', async () => {
  const f = fixture()
  const certificate = await f.certificate()
  const request = () => captureCreationCapabilitySource({ worktree: f.root, baseCommit: f.baseCommit,
    scope: f.scope, certificate, environment: process.env })
  writeFileSync(join(f.plugin, 'ignored.txt'), 'ignored')
  await expect(request()).rejects.toThrow('plugin file set')
  rmSync(join(f.plugin, 'ignored.txt'))
  symlinkSync('../README.md', join(f.plugin, 'src/link'))
  await expect(request()).rejects.toThrow()
  rmSync(join(f.plugin, 'src/link'))
  writeFileSync(join(f.plugin, 'src/huge.ts'), 'x'.repeat(65_537))
  await expect(request()).rejects.toThrow()
})

test('offline verification rejects forged object IDs, paths, data and object accessors', async () => {
  const f = fixture()
  const { certificate, snapshot } = await captured(f)
  const copy = () => JSON.parse(JSON.stringify(snapshot)) as CreationCapabilitySourceSnapshot
  const forged = copy()
  ;(forged.files as unknown as { oid: string }[])[0]!.oid = 'a'.repeat(40)
  expect(() => validateCreationCapabilitySource(forged, certificate)).toThrow()
  const traversal = copy()
  ;(traversal.entries as unknown as { path: string }[])[1]!.path = 'plugins/generated-demo/../escape'
  expect(() => validateCreationCapabilitySource(traversal, certificate)).toThrow()
  const altered = copy()
  ;(altered.files as unknown as { content: string }[])[0]!.content = 'forged'
  expect(() => validateCreationCapabilitySource(altered, certificate)).toThrow()
  const oversized = copy()
  ;(oversized.files as unknown as { content: string }[])[0]!.content = 'x'.repeat(1_048_576)
  expect(() => validateCreationCapabilitySource(oversized, certificate)).toThrow('file metadata')
  const { digest: _digest, ...payload } = oversized
  expect(() => creationCapabilitySourceDigest(payload)).toThrow('JSON string exceeds bound')
  const getter = copy()
  let called = false
  Object.defineProperty(getter.files[0], 'content', { enumerable: true, get() { called = true; return 'data' } })
  expect(() => validateCreationCapabilitySource(getter, certificate)).toThrow()
  expect(called).toBe(false)
})

test('rejects malformed staged UTF-8 without running package scripts', async () => {
  const f = fixture()
  writeFileSync(join(f.plugin, 'src/index.ts'), Buffer.from([0xc3, 0x28]))
  const certificate = await f.certificate()
  await expect(captureCreationCapabilitySource({ worktree: f.root, baseCommit: f.baseCommit, scope: f.scope,
    certificate, environment: process.env })).rejects.toThrow('not UTF-8')
})

test('rejects a nested Git repository staged as a gitlink', async () => {
  const f = fixture()
  const nested = join(f.plugin, 'src/nested')
  mkdirSync(nested)
  git(nested, 'init', '-q')
  git(nested, 'config', 'user.name', 'Nested Test')
  git(nested, 'config', 'user.email', 'nested@example.invalid')
  writeFileSync(join(nested, 'file.txt'), 'nested\n')
  git(nested, 'add', '--all')
  git(nested, 'commit', '-qm', 'nested')
  const certificate = await f.certificate()
  await expect(captureCreationCapabilitySource({ worktree: f.root, baseCommit: f.baseCommit, scope: f.scope,
    certificate, environment: process.env })).rejects.toThrow('index record')
})
