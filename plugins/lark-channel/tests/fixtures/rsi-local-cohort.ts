import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareRsiSourceWorkspace } from '../../src/rsi-source.js'
import { prepareRsiLocalCohort, type RsiLocalCohortPorts } from '../../src/rsi-local-cohort.js'

function run(file: string, args: string[], cwd: string): string {
  return execFileSync(file, args, { cwd, encoding: 'utf8', env: { ...process.env,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } }).trim()
}
function manifest(name: string, version: string, runtime: string[] = [], dev: string[] = [], peer: string[] = [], optional: string[] = []) {
  return { name, version, type: 'module', main: './lib/index.js', exports: { '.': './lib/index.js', './package.json': './package.json' },
    ...(name.includes('plugins/') ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {}),
    dependencies: Object.fromEntries(runtime.map(item => [item, 'workspace:*'])),
    optionalDependencies: Object.fromEntries(optional.map(item => [item, 'workspace:*'])),
    devDependencies: Object.fromEntries(dev.map(item => [item, 'workspace:*'])),
    peerDependencies: Object.fromEntries(peer.map(item => [item, 'workspace:*'])) }
}
export async function localCohortFixture(peerGraph = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rsi-cohort-')))
  const home = join(root, 'home'), sourceRepository = join(root, 'source'), profile = 'owner', version = '0.1.48'
  await mkdir(home, { mode: 0o700 }); await mkdir(sourceRepository)
  run('git', ['init', '--object-format=sha1', '--initial-branch=main', '.'], sourceRepository)
  await writeFile(join(sourceRepository, 'package.json'), JSON.stringify({ name: 'dsh-enhanced', version }, null, 2) + '\n')
  await writeFile(join(sourceRepository, 'pnpm-workspace.yaml'), 'packages:\n  - plugins/*\n  - packages/*\nallowBuilds:\n  esbuild: true\n  koffi: true\n  protobufjs: false\n')
  const names = ['target', 'assistant-policy', 'assistant-automations', 'plugin-control-plane', 'optional-plugin', 'dev-only', 'peer-only', 'shared-lib']
  for (const slug of names) {
    const base = slug === 'shared-lib' ? 'packages' : 'plugins', directory = join(sourceRepository, base, slug)
    await mkdir(join(directory, 'lib'), { recursive: true })
    const name = `@dsh-enhanced/${slug}`
    const runtime = slug === 'target' ? ['@dsh-enhanced/shared-lib'] : []
    const optional = slug === 'target' ? ['@dsh-enhanced/optional-plugin'] : []
    const dev = slug === 'target' ? ['@dsh-enhanced/dev-only'] : []
    const peer = slug === 'target' ? ['@dsh-enhanced/peer-only', ...(peerGraph ? ['@dsh-enhanced/shared-lib', '@dsh-enhanced/assistant-policy'] : [])]
      : peerGraph && slug === 'assistant-automations' ? ['@dsh-enhanced/assistant-policy']
        : peerGraph && slug === 'optional-plugin' ? ['@dsh-enhanced/shared-lib'] : []
    const pkg = { ...manifest(name, version, runtime, dev, peer, optional),
      peerDependenciesMeta: Object.fromEntries(peer.map(name => [name, { optional: true }])) }
    if (base === 'plugins') pkg.dsh = { bundle: { patch: './cordis.patch.yml' } }
    await writeFile(join(directory, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
    await writeFile(join(directory, 'lib', 'index.js'), `export const identity = '${slug}-committed'\n`)
    await writeFile(join(directory, 'README.md'), `# ${slug}\n`)
    await writeFile(join(directory, 'LICENSE'), 'MIT\n')
    if (base === 'plugins') await writeFile(join(directory, 'cordis.patch.yml'), '[]\n')
  }
  run('git', ['add', '.'], sourceRepository)
  run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'source'], sourceRepository)
  const source = await prepareRsiSourceWorkspace({ dshHome: home, profile, version, sourceRepository })
  let builds = 0
  const ports: RsiLocalCohortPorts = { build: async (workspace, output, paths) => {
    builds++
    for (const path of paths) {
      const slug = path.split('/')[1]!, packedRoot = join(output, '.packing', slug, 'package')
      await mkdir(packedRoot, { recursive: true })
      await mkdir(join(output, slug), { recursive: true })
      const pkg = JSON.parse(await readFile(join(workspace, path, 'package.json'), 'utf8')) as Record<string, unknown>
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        const map = pkg[field] as Record<string, string> | undefined
        if (map) for (const name of Object.keys(map)) map[name] = String(pkg.version)
      }
      await writeFile(join(packedRoot, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
      await mkdir(join(packedRoot, 'lib'))
      await copyFile(join(workspace, path, 'lib', 'index.js'), join(packedRoot, 'lib', 'index.js'))
      await copyFile(join(workspace, path, 'README.md'), join(packedRoot, 'README.md'))
      await copyFile(join(workspace, path, 'LICENSE'), join(packedRoot, 'LICENSE'))
      if (path.startsWith('plugins/')) await copyFile(join(workspace, path, 'cordis.patch.yml'), join(packedRoot, 'cordis.patch.yml'))
      await chmod(join(packedRoot, 'lib', 'index.js'), 0o644)
      run('/usr/bin/tar', ['-czf', join(output, slug, `${slug}.tgz`), 'package'], join(output, '.packing', slug))
    }
  } }
  return { root, home, sourceRepository, profile, version, source, ports, get builds() { return builds } }
}
export async function installFixture(f: Awaited<ReturnType<typeof localCohortFixture>>, cohort: Awaited<ReturnType<typeof prepareRsiLocalCohort>>,
  slugs = cohort.packages.map(pkg => pkg.name.split('/')[1]!), profile = 'profile') {
  const profilePath = join(f.root, profile)
  await mkdir(join(profilePath, 'node_modules', '@dsh-enhanced'), { recursive: true })
  await writeFile(join(profilePath, 'package.json'), JSON.stringify({ name: 'owner-profile', private: true }))
  for (const pkg of cohort.packages) {
    if (!slugs.includes(pkg.name.split('/')[1]!)) continue
    const destination = join(profilePath, 'node_modules', '@dsh-enhanced', pkg.name.split('/')[1]!)
    await mkdir(destination)
    run('/usr/bin/tar', ['-xzf', pkg.tarball, '--strip-components=1', '-C', destination], f.root)
  }
  return profilePath
}
