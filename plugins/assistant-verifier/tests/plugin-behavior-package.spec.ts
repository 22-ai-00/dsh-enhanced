import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

function command(file: string, args: string[], cwd = repository): string {
  const result = spawnSync(file, args, { cwd, encoding: 'utf8', timeout: 60_000 })
  expect(result.status, `${file} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(0)
  return result.stdout
}

test('a packed Verifier resolves its Isolation runner in a cold profile without mounting the Isolation bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-verifier-pack-'))
  try {
    const profile = join(root, 'profile')
    const scope = join(profile, 'node_modules', '@dsh-enhanced')
    await mkdir(scope, { recursive: true })
    for (const [kind, slug] of [
      ['packages', 'task-acceptance-contract'],
      ['plugins', 'assistant-verifier'],
      ['plugins', 'assistant-isolation'],
    ] as const) {
      const artifacts = join(root, `pack-${slug}`)
      await mkdir(artifacts)
      command('pnpm', ['--dir', join(repository, kind, slug), 'pack', '--pack-destination', artifacts])
      const packed = (await readdir(artifacts)).filter(name => name.endsWith('.tgz'))
      expect(packed).toHaveLength(1)
      const destination = join(scope, slug)
      await mkdir(destination)
      command('tar', ['-xzf', join(artifacts, packed[0]!), '-C', destination, '--strip-components=1'])
    }
    const manifest = JSON.parse(await readFile(join(scope, 'assistant-verifier', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>; dsh: { bundle: { patch: string } };
      exports: Record<string, { default: string }>
    }
    const isolationManifest = JSON.parse(await readFile(join(scope, 'assistant-isolation', 'package.json'), 'utf8')) as { version: string }
    expect(manifest.dependencies['@dsh-enhanced/assistant-isolation']).toBe(isolationManifest.version)
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.exports['./linux-behavior-runtime']?.default).toBe('./lib/linux-behavior-runtime.js')
    expect(manifest.exports['./plugin-behavior-config']?.default).toBe('./lib/plugin-behavior-config.js')
    expect(await readFile(join(scope, 'assistant-verifier', 'runtime', 'plugin-observer-launcher.c')))
      .toEqual(await readFile(join(repository, 'scripts', 'isolation', 'plugin-observer-launcher.c')))
    const deepseek = join(profile, 'node_modules', '@deepseek-ai')
    await mkdir(deepseek)
    for (const slug of ['cordis', 'dsh-tools', 'schemastery']) {
      await symlink(await realpath(join(repository, 'plugins', 'assistant-isolation', 'node_modules', '@deepseek-ai', slug)),
        join(deepseek, slug))
    }
    const isolation = join(scope, 'assistant-isolation')
    const disabled = join(scope, '.assistant-isolation-disabled')
    await rename(isolation, disabled)
    const runner = pathToFileURL(join(scope, 'assistant-verifier', 'lib', 'plugin-behavior-runner.js')).href
    const missing = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(runner)})`],
      { cwd: profile, encoding: 'utf8', timeout: 10_000 })
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain("Cannot find package '@dsh-enhanced/assistant-isolation'")
    await rename(disabled, isolation)
    const home = join(root, 'home')
    await mkdir(home)
    const assets = pathToFileURL(join(scope, 'assistant-verifier', 'lib', 'linux-behavior-assets.js')).href
    const runtime = pathToFileURL(join(scope, 'assistant-verifier', 'lib', 'linux-behavior-runtime.js')).href
    const loaded = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {createRequire} from 'node:module';
const require=createRequire(${JSON.stringify(join(profile, 'entry.mjs'))});
const config=require('@dsh-enhanced/assistant-verifier/plugin-behavior-config');
const linux=require('@dsh-enhanced/assistant-verifier/linux-behavior-runtime');
if(typeof config.validateCreationBehaviorDeploymentConfig!=='function'
 ||typeof linux.verifyLinuxPluginBehaviorAdoptionRuntime!=='function') throw Error('packed adoption exports missing');
const {PluginBehaviorRunner}=await import(${JSON.stringify(runner)});
if(typeof PluginBehaviorRunner!=='function') throw Error('runner missing');
const {prepareLinuxPluginBehaviorRuntime}=await import(${JSON.stringify(runtime)});
if(typeof prepareLinuxPluginBehaviorRuntime!=='function') throw Error('runtime preparation missing');
if(process.platform==='linux') {
const {loadLinuxBehaviorAssets}=await import(${JSON.stringify(assets)});
const value=await loadLinuxBehaviorAssets();
if(!/^[a-f0-9]{64}$/.test(value.sourceSha256)||!value.worker.includes('/runtime/0/dsh-plugin-verifier/candidate-launcher')
 ||value.worker.includes('/opt/dsh-plugin-verifier')||!value.launcher.includes('PR_SET_DUMPABLE')) throw Error('packed observer assets differ'); }`],
    { cwd: profile, encoding: 'utf8', timeout: 10_000, env: { ...process.env, HOME: home } })
    expect(loaded.status, loaded.stderr).toBe(0)
    expect(existsSync(join(home, '.dsh', 'assistant-isolation'))).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 120_000)
