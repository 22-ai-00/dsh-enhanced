import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { inspectSourceCreationContext, prepareCreatedPluginWorkspace, validateSourceCreationFiles,
  verifyCreatedPluginWorkspace, type SourceCreationGrant } from '../src/source-creation.ts'
import { createIsolatedWorktree } from '../src/source-workspace.ts'
import { createSourceCreationFixture } from './helpers/source-creation-fixture.ts'

const sourceRoot = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/u, '')
const name = 'rsi-native-tools-probe'
const packageName = `@dsh-enhanced/${name}`
const sdk = '@deepseek-ai/dsh-tools'
const systemPrompt = '@deepseek-ai/dsh-system-prompt'
const signal = new AbortController().signal
const environment = process.env
const grant: SourceCreationGrant = { id: 'native-tools-create', expiresAt: Date.now() + 600_000,
  maxCreates: 1, namePrefix: 'rsi-native-' }
let root: string
let repository: string
let baseCommit: string
let isolated: Awaited<ReturnType<typeof createIsolatedWorktree>>

const candidate = [{ path: 'src/native-tool.ts', content: `import { defineTool } from '${sdk}'

export const nativeTool = defineTool({
  name: 'native_probe',
  description: 'Return one typed probe value.',
  parameters: { value: { type: 'string', required: true } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
      value: { type: 'string', required: true },
    } },
    render: (_args, result) => [{ type: 'text', text: result.value }],
  },
  execute: async args => ({ value: args.value }),
})
` }]

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-native-tools-create-'))
  const fixture = await createSourceCreationFixture(sourceRoot, join(root, 'repository'))
  repository = fixture.repository
  baseCommit = fixture.baseCommit
  isolated = await createIsolatedWorktree({ stateRoot: join(root, 'private'), repository, baseCommit, environment })
})

afterAll(async () => {
  if (isolated) await isolated.remove()
  if (root) await rm(root, { recursive: true, force: true })
})

it('provides the native Tools SDK through the real generator and a single frozen lock importer', async () => {
  const view = await inspectSourceCreationContext({ repository, name,
    paths: ['package.json', 'README.md', 'src/index.ts'], baseCommit, environment, signal,
    assertCurrent: () => undefined, grant })
  const manifest = JSON.parse(view.contents.find(file => file.path === 'package.json')!.content) as {
    name: string; peerDependencies: Record<string, string>; peerDependenciesMeta: Record<string, { optional: boolean }>
    devDependencies: Record<string, string>
  }
  expect(manifest.name).toBe(packageName)
  expect(manifest.peerDependencies[sdk]).toBe('>=0.1.5-rc.3 <0.1.6')
  expect(manifest.peerDependenciesMeta[sdk]).toEqual({ optional: true })
  expect(manifest.devDependencies[sdk]).toBe('catalog:')
  expect(manifest.devDependencies[systemPrompt]).toBe('catalog:')
  expect(view.contents.find(file => file.path === 'README.md')!.content).toContain('defineTool')
  expect(view.contents.find(file => file.path === 'README.md')!.content).toContain(sdk)
  expect(view.contents.find(file => file.path === 'src/index.ts')!.content).not.toContain('defineTool')

  const creation = { grant, generatorDigest: view.generatorDigest }
  const prepared = await prepareCreatedPluginWorkspace({ worktree: isolated.worktree, baseCommit, name,
    files: candidate, environment, signal, assertCurrent: () => undefined, creation })
  expect(prepared.scope).toEqual([`plugins/${name}`, 'plugins/README.md', 'pnpm-lock.yaml'])
  expect(await readFile(join(isolated.worktree, 'plugins', name, 'src', 'native-tool.ts'), 'utf8'))
    .toBe(candidate[0]!.content)
  const originalLock = await readFile(join(repository, 'pnpm-lock.yaml'), 'utf8')
  const generatedLock = await readFile(join(isolated.worktree, 'pnpm-lock.yaml'), 'utf8')
  const importer = generatedLock.match(new RegExp(`\\n  plugins/${name}:\\n[\\s\\S]*?(?=\\npackages:\\n)`, 'u'))?.[0]
  expect(importer).toBeDefined()
  expect(generatedLock.split(`\n  plugins/${name}:\n`)).toHaveLength(2)
  expect(generatedLock.replace(importer!, '')).toBe(originalLock)
  expect(importer).toContain(`'${sdk}':\n        specifier: 'catalog:'`)
  expect(importer).toMatch(/'@deepseek-ai\/dsh-tools':\n        specifier: 'catalog:'\n        version: "0\.1\.5-rc\.3[^"\n]*"/u)
  expect(importer!.match(/'@deepseek-ai\/dsh-system-prompt':/gu)).toHaveLength(1)
  expect(importer).toMatch(/'@deepseek-ai\/dsh-system-prompt':\n        specifier: 'catalog:'\n        version: "0\.1\.5-rc\.3[^"\n]*"/u)
  await expect(verifyCreatedPluginWorkspace({ worktree: isolated.worktree, baseCommit, name,
    environment, signal, assertCurrent: () => undefined, creation, files: candidate })).resolves.toEqual(prepared)

  if (environment.DSH_CREATION_REAL_FROZEN === '1') {
    const install = spawnSync('pnpm', ['install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--trust-lockfile',
      '--filter', packageName], { cwd: isolated.worktree, encoding: 'utf8', timeout: 180_000,
      maxBuffer: 4_194_304, env: { ...environment, CI: '1', NPM_CONFIG_OFFLINE: 'true', COREPACK_ENABLE_NETWORK: '0' } })
    expect(install.status, `${install.error?.message ?? ''}\n${install.stdout}\n${install.stderr}`).toBe(0)
    expect(install.stdout).toContain('Lockfile is up to date')
  } else {
    // This link only tests installed SDK type resolution; it is not an install check.
    await symlink(join(sourceRoot, 'plugins', 'assistant-health', 'node_modules'),
      join(isolated.worktree, 'plugins', name, 'node_modules'), 'dir')
  }
  const checked = spawnSync(join(sourceRoot, 'node_modules', '.bin', 'tsc'),
    ['-p', join(isolated.worktree, 'plugins', name, 'tsconfig.json'), '--noEmit'],
    { cwd: isolated.worktree, encoding: 'utf8', timeout: 60_000, maxBuffer: 4_194_304 })
  expect(checked.status, `${checked.error?.message ?? ''}\n${checked.stdout}\n${checked.stderr}`).toBe(0)
  await rm(join(isolated.worktree, 'plugins', name, 'node_modules'), { recursive: true, force: true })
  await expect(verifyCreatedPluginWorkspace({ worktree: isolated.worktree, baseCommit, name,
    environment, signal, assertCurrent: () => undefined, creation, files: candidate })).resolves.toEqual(prepared)

  const manifestPath = join(isolated.worktree, 'plugins', name, 'package.json')
  const originalManifest = await readFile(manifestPath, 'utf8')
  const changedManifest = (change: (value: typeof manifest) => void) => {
    const value = JSON.parse(originalManifest) as typeof manifest
    change(value)
    return `${JSON.stringify(value, null, 2)}\n`
  }
  for (const changed of [
    changedManifest(value => { value.peerDependencies[sdk] = '>=0.1.5-rc.2 <0.1.6' }),
    changedManifest(value => { value.devDependencies[sdk] = '0.1.5-rc.2' }),
  ]) {
    await writeFile(manifestPath, changed)
    await expect(verifyCreatedPluginWorkspace({ worktree: isolated.worktree, baseCommit, name,
      environment, signal, assertCurrent: () => undefined, creation, files: candidate }))
      .rejects.toThrow('Host-owned generated file changed: package.json')
  }
  await writeFile(manifestPath, originalManifest)

  const lockPath = join(isolated.worktree, 'pnpm-lock.yaml')
  const changedImporter = importer!.replace("'@deepseek-ai/dsh-tools':\n        specifier: 'catalog:'",
    "'@deepseek-ai/dsh-tools':\n        specifier: 0.1.5-rc.2")
  expect(changedImporter).not.toBe(importer)
  await writeFile(lockPath, generatedLock.replace(importer!, changedImporter))
  await expect(verifyCreatedPluginWorkspace({ worktree: isolated.worktree, baseCommit, name,
    environment, signal, assertCurrent: () => undefined, creation, files: candidate }))
    .rejects.toThrow('Host-owned new lock importer changed')
  const changedBaseProjection = generatedLock.replace("  .:\n", "  .:\n    unauthorized:\n")
  expect(changedBaseProjection).not.toBe(generatedLock)
  await writeFile(lockPath, changedBaseProjection)
  await expect(verifyCreatedPluginWorkspace({ worktree: isolated.worktree, baseCommit, name,
    environment, signal, assertCurrent: () => undefined, creation, files: candidate }))
    .rejects.toThrow('Host-owned new lock importer changed')
  await writeFile(lockPath, generatedLock)
  await expect(verifyCreatedPluginWorkspace({ worktree: isolated.worktree, baseCommit, name,
    environment, signal, assertCurrent: () => undefined, creation, files: candidate })).resolves.toEqual(prepared)
}, 240_000)

it('keeps the candidate write boundary at README, src and tests', () => {
  for (const path of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'src/version.ts',
    'tests/native/package.json']) {
    expect(() => validateSourceCreationFiles([{ path, content: 'tampered' }])).toThrow('candidate authority')
  }
  expect(() => validateSourceCreationFiles(candidate)).not.toThrow()
})
