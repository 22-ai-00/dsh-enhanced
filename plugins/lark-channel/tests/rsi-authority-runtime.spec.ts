import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { loadTrustConfig } from '@dsh-enhanced/plugin-control-plane'
import { prepareRsiAuthorityRuntime, replaceRsiAuthorityRuntimeInStage } from '../src/rsi-authority-runtime.js'
import { createRsiAuthorityFixture } from './fixtures/rsi-authorities.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rsi-authority-runtime-'))); roots.push(root)
  const home = join(root, 'home # % spaced'), packageRoot = join(root, 'control-plane')
  const installed = dirname(createRequire(import.meta.url).resolve('@dsh-enhanced/plugin-control-plane/package.json'))
  await mkdir(home, { mode: 0o700 })
  await mkdir(join(packageRoot, 'bin'), { recursive: true, mode: 0o700 })
  await mkdir(join(packageRoot, 'lib'), { mode: 0o700 })
  await cp(join(installed, 'package.json'), join(packageRoot, 'package.json'))
  for (const name of await readdir(join(installed, 'lib'))) {
    if (name.endsWith('.js')) await cp(join(installed, 'lib', name), join(packageRoot, 'lib', name))
  }
  for (const name of ['dsh-source-approval-authority.js', 'dsh-source-release-authority.js',
    'dsh-source-adoption-authority.js', 'dsh-task-observation-authority.js', 'dsh-live-qualification-authority.js',
    'dsh-systemd-host-authority.js', 'dsh-systemd-host-attestor.js', 'dsh-local-release-adapter.js']) {
    await cp(join(installed, 'bin', name), join(packageRoot, 'bin', name))
  }
  const contractRoot = await realpath(join(installed, 'node_modules', '@dsh-enhanced', 'assistant-growth-contract'))
  const contractTarget = join(packageRoot, 'node_modules', '@dsh-enhanced', 'assistant-growth-contract')
  await mkdir(join(contractTarget, 'lib'), { recursive: true, mode: 0o700 })
  await cp(join(contractRoot, 'package.json'), join(contractTarget, 'package.json'))
  for (const name of await readdir(join(contractRoot, 'lib'))) {
    if (name.endsWith('.js')) await cp(join(contractRoot, 'lib', name), join(contractTarget, 'lib', name))
  }
  return { root, home, packageRoot, final: join(home, 'rsi-authority-runtimes', 'owner'),
    input: { dshHome: home, profile: 'owner' } }
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
describe.skipIf(process.platform !== 'linux')('private authority runtime', () => {
  test('copies runnable official assets, returns trust-compatible private pins, and replays identically', async () => {
    const f = await fixture()
    const result = await prepareRsiAuthorityRuntime(f.input, { packageRoot: f.packageRoot })
    expect(await prepareRsiAuthorityRuntime(f.input, { packageRoot: f.packageRoot })).toEqual(result)
    expect(result.node.path).toBe(join(f.final, 'node'))
    expect(Object.keys(result.releaseAdapters)).toHaveLength(8)
    const inodes = new Set<number>()
    for (const pin of [...Object.values(result.executables), ...Object.values(result.releaseAdapters)]) {
      const item = await lstat(pin.path), bytes = await readFile(pin.path)
      expect(item.isFile()).toBe(true)
      expect(item.nlink).toBe(1)
      expect(item.mode & 0o777).toBe(0o700)
      expect(sha(bytes)).toBe(pin.sha256)
      expect(bytes.toString('utf8', 0, 256).split('\n')[0]).toBe(`#!${result.node.path}`)
      inodes.add(item.ino)
    }
    expect(inodes.size).toBe(15)
    for (const pin of [result.processHelper, result.observerClient, result.catalogValidator, result.catalogInterpreter]) {
      expect(sha(await readFile(pin.path))).toBe(pin.sha256)
      expect((await lstat(pin.path)).mode & 0o777).toBe(0o600)
    }
    expect((await lstat(f.final)).mode & 0o777).toBe(0o700)
    expect((await lstat(result.node.path)).mode & 0o777).toBe(0o700)
    expect(await readFile(join(f.final, 'package.json'), 'utf8')).toBe('{"type":"module"}\n')
    const trustFixture = await createRsiAuthorityFixture()
    try {
      const trustPath = trustFixture.manifest.controlPlane.trustPath
      const trust = JSON.parse(await readFile(trustPath, 'utf8')) as Record<string, any>
      const interpreter = result.node
      trust.hostAttestor = { ...trust.hostAttestor, ...result.executables.hostAttestor,
        version: 'dsh-systemd-host-attestor-8', interpreter }
      for (const phase of Object.keys(result.releaseAdapters) as (keyof typeof result.releaseAdapters)[]) {
        trust.releaseAdapters[phase] = { ...trust.releaseAdapters[phase], ...result.releaseAdapters[phase],
          version: 'dsh-local-release-adapter-1', interpreter }
      }
      await writeFile(trustPath, `${JSON.stringify(trust)}\n`)
      const loaded = await loadTrustConfig(trustPath)
      expect(loaded.hostAttestor?.path).toBe(result.executables.hostAttestor.path)
      expect(loaded.releaseAdapters?.pr?.path).toBe(result.releaseAdapters.pr.path)
      trust.releaseAdapters.review.path = trust.releaseAdapters.pr.path
      trust.releaseAdapters.review.sha256 = trust.releaseAdapters.pr.sha256
      await writeFile(trustPath, `${JSON.stringify(trust)}\n`)
      await expect(loadTrustConfig(trustPath)).rejects.toThrow(/independent/u)
    } finally { await trustFixture.dispose() }
    await rm(f.packageRoot, { recursive: true })
    const isolated = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: f.final }
    const attestor = spawnSync(result.node.path, [result.executables.hostAttestor.path, '--version'], { env: isolated, encoding: 'utf8', timeout: 10_000 })
    expect(attestor.status).toBe(0)
    expect(attestor.stdout.trim()).toBe('dsh-systemd-host-attestor-8')
    const adapter = spawnSync(result.node.path, [result.releaseAdapters.pr.path, '--version'], { env: isolated, encoding: 'utf8', timeout: 10_000 })
    expect(adapter.status).toBe(0)
    expect(adapter.stdout.trim()).toBe('dsh-local-release-adapter-1')
    const modules = ['source-approval-authority', 'source-release-authority', 'source-adoption-authority',
      'task-observation-authority', 'live-qualification-authority', 'systemd-host-authority',
      'runtime-observer-protocol', 'adapter-process']
    const urls = modules.map(name => pathToFileURL(join(f.final, 'lib', `${name}.js`)).href)
    const imported = spawnSync(result.node.path, ['--input-type=module', '--eval', `await Promise.all(${JSON.stringify(urls)}.map(url => import(url)))`],
      { env: isolated, encoding: 'utf8', timeout: 10_000 })
    expect(imported.status).toBe(0)
    await expect(prepareRsiAuthorityRuntime({ dshHome: `${f.home}\r`, profile: 'owner' })).rejects.toThrow('invalid home')
    await expect(prepareRsiAuthorityRuntime({ dshHome: `${f.home}\n`, profile: 'owner' })).rejects.toThrow('invalid home')
  }, 120_000)

  test('refuses changed source and missing, tampered, linked, or extra deployed assets', async () => {
    const f = await fixture()
    await prepareRsiAuthorityRuntime(f.input, { packageRoot: f.packageRoot })
    const source = join(f.packageRoot, 'lib', 'adapter-process.js')
    const original = await readFile(source)
    await writeFile(source, Buffer.concat([original, Buffer.from('\n// changed\n')]))
    await expect(prepareRsiAuthorityRuntime(f.input, { packageRoot: f.packageRoot })).rejects.toThrow()
    await writeFile(source, original)
    const deployed = join(f.final, 'lib', 'adapter-process.js')
    await rm(deployed)
    await expect(prepareRsiAuthorityRuntime(f.input, { packageRoot: f.packageRoot })).rejects.toThrow()
    await writeFile(deployed, original, { mode: 0o600 })
    await writeFile(deployed, 'tamper')
    await expect(prepareRsiAuthorityRuntime(f.input, { packageRoot: f.packageRoot })).rejects.toThrow()
    await rm(deployed)
    await symlink(source, deployed)
    await expect(prepareRsiAuthorityRuntime(f.input, { packageRoot: f.packageRoot })).rejects.toThrow()
    await rm(deployed)
    await writeFile(deployed, original, { mode: 0o600 })
    await writeFile(join(f.final, 'lib', 'unexpected.js'), '')
    await expect(prepareRsiAuthorityRuntime(f.input, { packageRoot: f.packageRoot })).rejects.toThrow()
  }, 120_000)

  test('pins shared contract bytes and refuses dependency substitution, tampering or extra directories', async () => {
    const f = await fixture()
    const controlManifestPath = join(f.packageRoot, 'package.json')
    const originalControlManifest = await readFile(controlManifestPath)
    const controlManifest = JSON.parse(originalControlManifest.toString('utf8')) as { dependencies: Record<string, string> }
    delete controlManifest.dependencies['@dsh-enhanced/assistant-growth-contract']
    await writeFile(controlManifestPath, JSON.stringify(controlManifest))
    await expect(prepareRsiAuthorityRuntime(f.input, { packageRoot: f.packageRoot })).rejects.toThrow('not declared')
    await writeFile(controlManifestPath, originalControlManifest)
    const contract = join('node_modules', '@dsh-enhanced', 'assistant-growth-contract')
    const sourceManifest = join(f.packageRoot, contract, 'package.json')
    const originalManifest = await readFile(sourceManifest)
    await writeFile(sourceManifest, JSON.stringify({ ...JSON.parse(originalManifest.toString()), version: '0.0.0' }))
    await expect(prepareRsiAuthorityRuntime(f.input, { packageRoot: f.packageRoot })).rejects.toThrow('shared contract identity')
    await writeFile(sourceManifest, originalManifest)
    await prepareRsiAuthorityRuntime(f.input, { packageRoot: f.packageRoot })
    const deployed = join(f.final, contract, 'lib', 'source-run.js')
    const original = await readFile(deployed)
    await writeFile(deployed, 'tampered contract')
    await expect(prepareRsiAuthorityRuntime(f.input, { packageRoot: f.packageRoot })).rejects.toThrow('deployed asset changed')
    await writeFile(deployed, original)
    await rm(deployed)
    await symlink(join(f.packageRoot, contract, 'lib', 'source-run.js'), deployed)
    await expect(prepareRsiAuthorityRuntime(f.input, { packageRoot: f.packageRoot })).rejects.toThrow('linked or unowned')
    await rm(deployed)
    await writeFile(deployed, original, { mode: 0o600 })
    await mkdir(join(f.final, 'node_modules', 'unexpected'), { mode: 0o700 })
    await expect(prepareRsiAuthorityRuntime(f.input, { packageRoot: f.packageRoot })).rejects.toThrow('unexpected runtime directory')
  }, 120_000)

  test('stage replacement persists logical source paths and replays after Home swap', async () => {
    const f = await fixture()
    await prepareRsiAuthorityRuntime(f.input, { packageRoot: f.packageRoot })
    const stageHome = join(f.root, 'stage-home'), previousHome = join(f.root, 'previous-home')
    await cp(f.home, stageHome, { recursive: true })
    const installed = join(stageHome, 'profiles', 'owner', 'node_modules', '@dsh-enhanced', 'plugin-control-plane')
    await mkdir(dirname(installed), { recursive: true, mode: 0o700 })
    await cp(f.packageRoot, installed, { recursive: true })
    await replaceRsiAuthorityRuntimeInStage({ logicalHome: f.home, physicalHome: stageHome, profile: 'owner' },
      { packageRoot: installed })
    const source = JSON.parse(await readFile(join(stageHome, 'rsi-authority-runtimes', 'owner', 'receipt.json'), 'utf8')) as {
      entries: Array<{ sourcePath: string }>
    }
    expect(source.entries.some(entry => entry.sourcePath.startsWith(stageHome))).toBe(false)
    expect(source.entries.some(entry => entry.sourcePath.startsWith(join(f.home, 'profiles')))).toBe(true)
    await rename(f.home, previousHome)
    await rename(stageHome, f.home)
    expect(await prepareRsiAuthorityRuntime(f.input, { packageRoot: join(f.home, 'profiles', 'owner',
      'node_modules', '@dsh-enhanced', 'plugin-control-plane') })).toHaveProperty('root', f.final)
  }, 120_000)

  test('stage replacement resolves a pnpm adjacent contract edge and replays after Home swap', async () => {
    const f = await fixture()
    await prepareRsiAuthorityRuntime(f.input, { packageRoot: f.packageRoot })
    const stageHome = join(f.root, 'pnpm-stage-home'), previousHome = join(f.root, 'pnpm-previous-home')
    await cp(f.home, stageHome, { recursive: true })
    const packageVersion = (JSON.parse(await readFile(join(f.packageRoot, 'package.json'), 'utf8')) as { version: string }).version
    const virtualRoot = join(stageHome, 'profiles', 'owner', 'node_modules', '.pnpm')
    const namespace = join(virtualRoot, `@dsh-enhanced+plugin-control-plane@${packageVersion}`, 'node_modules', '@dsh-enhanced')
    const installed = join(namespace, 'plugin-control-plane')
    const contractEdge = join(namespace, 'assistant-growth-contract')
    const contractTarget = join(virtualRoot, `@dsh-enhanced+assistant-growth-contract@${packageVersion}`, 'node_modules',
      '@dsh-enhanced', 'assistant-growth-contract')
    await mkdir(namespace, { recursive: true, mode: 0o700 })
    await cp(f.packageRoot, installed, { recursive: true })
    await mkdir(dirname(contractTarget), { recursive: true, mode: 0o700 })
    await cp(join(f.packageRoot, 'node_modules', '@dsh-enhanced', 'assistant-growth-contract'),
      contractTarget, { recursive: true })
    await rm(join(installed, 'node_modules'), { recursive: true })
    await symlink(relative(dirname(contractEdge), contractTarget), contractEdge, 'dir')
    await replaceRsiAuthorityRuntimeInStage({ logicalHome: f.home, physicalHome: stageHome, profile: 'owner' },
      { packageRoot: installed })
    const receipt = JSON.parse(await readFile(join(stageHome, 'rsi-authority-runtimes', 'owner', 'receipt.json'), 'utf8')) as {
      entries: Array<{ path: string; sourcePath: string }>
    }
    const contractSource = receipt.entries.find(entry => entry.path === 'node_modules/@dsh-enhanced/assistant-growth-contract/package.json')
    expect(contractSource?.sourcePath).toBe(join(f.home, relative(stageHome, contractTarget), 'package.json'))
    expect(receipt.entries.some(entry => entry.sourcePath.startsWith(stageHome))).toBe(false)
    await rename(f.home, previousHome)
    await rename(stageHome, f.home)
    expect(await prepareRsiAuthorityRuntime(f.input, { packageRoot: join(f.home, relative(stageHome, installed)) }))
      .toHaveProperty('root', f.final)
  }, 120_000)

  test('rejects contract resolution inherited from an ancestor node_modules', async () => {
    const f = await fixture()
    const ancestorContract = join(f.root, 'node_modules', '@dsh-enhanced', 'assistant-growth-contract')
    await mkdir(dirname(ancestorContract), { recursive: true, mode: 0o700 })
    await cp(join(f.packageRoot, 'node_modules', '@dsh-enhanced', 'assistant-growth-contract'),
      ancestorContract, { recursive: true })
    await rm(join(f.packageRoot, 'node_modules'), { recursive: true })
    await expect(prepareRsiAuthorityRuntime(f.input, { packageRoot: f.packageRoot }))
      .rejects.toThrow('outside its dependency edge')
  }, 120_000)

  test('rejects a declared contract supplied only by a flat project peer', async () => {
    const f = await fixture()
    const namespace = join(f.root, 'profile', 'node_modules', '@dsh-enhanced')
    const installed = join(namespace, 'plugin-control-plane')
    const contract = join(namespace, 'assistant-growth-contract')
    await mkdir(namespace, { recursive: true, mode: 0o700 })
    await cp(f.packageRoot, installed, { recursive: true })
    await cp(join(f.packageRoot, 'node_modules', '@dsh-enhanced', 'assistant-growth-contract'),
      contract, { recursive: true })
    await rm(join(installed, 'node_modules'), { recursive: true })
    const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(manifest.dependencies['@dsh-enhanced/assistant-growth-contract']).toBeDefined()
    await expect(prepareRsiAuthorityRuntime(f.input, { packageRoot: installed }))
      .rejects.toThrow('outside its dependency edge')
  }, 120_000)

  test('cancellation leaves no runtime; failed copied CLI removes only its claimed runtime', async () => {
    const f = await fixture()
    const controller = new AbortController(); controller.abort()
    await expect(prepareRsiAuthorityRuntime({ ...f.input, signal: controller.signal }, { packageRoot: f.packageRoot })).rejects.toThrow()
    expect(await readdir(join(f.home, 'rsi-authority-runtimes'))).toEqual([])
    await writeFile(join(f.packageRoot, 'bin', 'dsh-systemd-host-attestor.js'), '#!/usr/bin/env node\nprocess.exit(7)\n')
    await expect(prepareRsiAuthorityRuntime(f.input, { packageRoot: f.packageRoot })).rejects.toThrow()
    expect(await readdir(join(f.home, 'rsi-authority-runtimes'))).toEqual([])
  }, 120_000)
})
