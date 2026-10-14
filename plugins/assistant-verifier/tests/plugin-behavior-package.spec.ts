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
      dependencies: Record<string, string>; dsh: { bundle: { patch: string } }
    }
    const isolationManifest = JSON.parse(await readFile(join(scope, 'assistant-isolation', 'package.json'), 'utf8')) as { version: string }
    expect(manifest.dependencies['@dsh-enhanced/assistant-isolation']).toBe(isolationManifest.version)
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
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
    const loaded = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const {PluginBehaviorRunner}=await import(${JSON.stringify(runner)}); if(typeof PluginBehaviorRunner!=='function') throw Error('runner missing');`],
    { cwd: profile, encoding: 'utf8', timeout: 10_000, env: { ...process.env, HOME: home } })
    expect(loaded.status, loaded.stderr).toBe(0)
    expect(existsSync(join(home, '.dsh', 'assistant-isolation'))).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 120_000)
