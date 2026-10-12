import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-setup-runtime-')))
  roots.push(root)
  const home = join(root, 'home')
  const profile = join(home, 'profiles', 'assistant')
  const packageRoot = join(profile, 'node_modules', '@dsh-enhanced', 'assistant-policy')
  const hostRoot = join(root, 'host', 'node_modules', '@deepseek-ai', 'dsh')
  const hostModules = dirname(hostRoot)
  const bin = join(root, 'bin')
  const executable = join(hostRoot, 'lib', 'bin.js')
  const output = join(root, 'result.json')
  const require = createRequire(import.meta.url)
  const cordis = dirname(require.resolve('@deepseek-ai/cordis/package.json'))
  const store = join(process.cwd(), 'node_modules', '.pnpm')
  const bootStore = (await readdir(store)).find(name => name.startsWith('@deepseek-ai+dsh-app-boot@0.2.0-rc.2_'))
  if (bootStore === undefined) throw new Error('locked DSH 0.2 app-boot is not installed')
  const boot = join(store, bootStore, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
  await Promise.all([
    mkdir(join(packageRoot, 'lib'), { recursive: true }),
    mkdir(join(packageRoot, 'bin'), { recursive: true }),
    mkdir(join(hostRoot, 'lib'), { recursive: true }),
    mkdir(bin),
  ])
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-assistant', type: 'module',
    dependencies: { '@dsh-enhanced/assistant-policy': '0.0.0' }, dsh: { profile: { bundles: [] } } }))
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/assistant-policy',
    version: '0.0.0', type: 'module', bin: { 'dsh-model-setup': './bin/dsh-model-setup.js' },
    peerDependencies: { '@deepseek-ai/cordis': '*' } }))
  await writeFile(join(packageRoot, 'bin', 'dsh-model-setup.js'), 'export {}\n')
  await writeFile(join(packageRoot, 'lib', 'model-setup.js'), `import { Context } from '@deepseek-ai/cordis'
import { writeFile } from 'node:fs/promises'
export async function runModelSetup(args) {
  if (typeof Context !== 'function') throw new Error('Host Cordis unavailable')
  if (args.includes('--reject')) { await Promise.resolve(); throw new Error('setup rejected') }
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  await new Promise(resolve => setTimeout(resolve, 25))
  await writeFile(process.env.SETUP_RESULT, JSON.stringify({ args, input, tty: process.stdin.isTTY === true }))
}
`)
  await writeFile(join(hostRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2',
    type: 'module', bin: { dsh: 'lib/bin.js' }, dependencies: { '@deepseek-ai/dsh-app-boot': '0.2.0-rc.2',
      '@deepseek-ai/cordis': '4.0.4' }, exports: { './package.json': './package.json' } }))
  await writeFile(executable, '#!/usr/bin/env node\nif (process.argv[2] === "--version") process.stdout.write("0.2.0-rc.2\\n")\n')
  await chmod(executable, 0o755)
  await symlink(await realpath(boot), join(hostModules, 'dsh-app-boot'))
  await symlink(await realpath(cordis), join(hostModules, 'cordis'))
  await symlink(executable, join(bin, 'dsh'))
  return { root, home, profile, packageRoot, hostRoot, bin, output }
}

async function nestedPolicyFixture() {
  const instance = await fixture()
  const bundle = join(instance.root, 'local-bundles', 'personal-assistant')
  const policy = join(instance.root, 'local-bundles', 'assistant-policy')
  await mkdir(join(bundle, 'node_modules', '@dsh-enhanced'), { recursive: true })
  await rename(instance.packageRoot, policy)
  await writeFile(join(policy, 'lib', 'model-setup.js'), `import { writeFile } from 'node:fs/promises'
export async function runModelSetup(args) {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  await writeFile(process.env.SETUP_RESULT, JSON.stringify({ args, input, tty: process.stdin.isTTY === true }))
}
`)
  await symlink(policy, join(bundle, 'node_modules', '@dsh-enhanced', 'assistant-policy'))
  await symlink(bundle, join(instance.profile, 'node_modules', '@dsh-enhanced', 'personal-assistant'))
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/personal-assistant',
    version: '0.0.0', type: 'module', dependencies: { '@dsh-enhanced/assistant-policy': '0.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(bundle, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(instance.profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-assistant', type: 'module',
    dependencies: { '@dsh-enhanced/personal-assistant': '0.0.0' },
    dsh: { profile: { bundles: ['@dsh-enhanced/personal-assistant'] } } }))
  return { ...instance, packageRoot: policy, bundle }
}

function run(home: string, bin: string, output: string, args: string[], input = '', environment: NodeJS.ProcessEnv = {}) {
  return spawnSync('/bin/bash', ['-c', 'source "$1"; dsh_enhanced_run_profile_setup 0 "$2" assistant dsh-model-setup "${@:3}"',
    'setup-test', join(process.cwd(), 'scripts/install/common.sh'), home, ...args], {
    encoding: 'utf8', input, env: { ...process.env, NODE_PATH: '', PATH: `${bin}:${process.env.PATH ?? ''}`, SETUP_RESULT: output, ...environment },
  })
}

test('DSH 0.2 setup resolves Host peers in-process, awaits completion and retains stdin without shared links', async () => {
  const { home, bin, output } = await fixture()
  const result = run(home, bin, output, ['--smoke', 'native'], 'owner input\n')
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({ args: ['--smoke', 'native'], input: 'owner input\n', tty: false })
  expect(existsSync(join(home, 'profiles', 'node_modules'))).toBe(false)
})

test('DSH 0.2 setup resolves a policy nested under a selected local bundle link', async () => {
  const { home, bin, output } = await nestedPolicyFixture()
  const result = run(home, bin, output, ['--smoke', 'nested'], 'owner input\n')
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({ args: ['--smoke', 'nested'], input: 'owner input\n', tty: false })
  expect(existsSync(join(home, 'profiles', 'assistant', 'node_modules', '@dsh-enhanced', 'assistant-policy'))).toBe(false)
})

test('DSH 0.2 setup ignores inherited Node preload and global module lookup settings', async () => {
  const { root, home, bin, output } = await fixture()
  const preload = join(root, 'preload.cjs')
  const marker = join(root, 'preloaded')
  await writeFile(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected')`)
  const result = run(home, bin, output, [], '', { NODE_OPTIONS: `--require=${preload}`, NODE_PATH: root })
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(marker)).toBe(false)
  expect(existsSync(output)).toBe(true)
})

test('DSH 0.2 setup rejects an impostor nested package and an undeclared transitive package', async () => {
  const { home, bin, output, packageRoot, bundle } = await nestedPolicyFixture()
  const manifestPath = join(packageRoot, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await writeFile(manifestPath, JSON.stringify({ ...manifest, name: '@dsh-enhanced/impostor' }))
  const impostor = run(home, bin, output, [])
  expect(impostor.status).not.toBe(0)
  expect(impostor.stderr).toContain('setup package identity or bin ownership differs')
  await writeFile(manifestPath, JSON.stringify(manifest))
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/personal-assistant',
    version: '0.0.0', type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  const undeclared = run(home, bin, output, [])
  expect(undeclared.status).not.toBe(0)
  expect(undeclared.stderr).toContain('setup package differs from native profile resolution')
  expect(existsSync(output)).toBe(false)
})

test('DSH 0.2 setup propagates awaited rejection and rejects package identity drift', async () => {
  const { home, bin, output, packageRoot } = await fixture()
  const rejected = run(home, bin, output, ['--reject'])
  expect(rejected.status).not.toBe(0)
  expect(rejected.stderr).toContain('setup rejected')
  expect(existsSync(output)).toBe(false)
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/impostor', version: '0.0.0',
    type: 'module', bin: { 'dsh-model-setup': './bin/dsh-model-setup.js' } }))
  const impostor = run(home, bin, output, [])
  expect(impostor.status).not.toBe(0)
  expect(impostor.stderr).toContain('setup package identity or bin ownership differs')
  expect(existsSync(output)).toBe(false)
})

test('DSH 0.2 setup rejects a selected executable with a mismatched Host manifest', async () => {
  const { home, bin, output, hostRoot } = await fixture()
  const path = join(hostRoot, 'package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.version = '0.1.5-rc.3'
  await writeFile(path, JSON.stringify(manifest))
  const result = run(home, bin, output, [])
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('selected dsh executable is not owned by verified Host')
  expect(existsSync(output)).toBe(false)
})

test('DSH 0.2 source setup initializes an absent profile but rejects an invalid existing profile', async () => {
  const { root, home, profile, bin, output } = await fixture()
  const checkout = join(root, 'checkout')
  const packageRoot = join(checkout, 'plugins', 'lark-channel')
  await mkdir(join(packageRoot, 'bin'), { recursive: true })
  await mkdir(join(packageRoot, 'lib'))
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/lark-channel',
    version: '0.0.0', type: 'module', bin: { 'dsh-rsi-setup': './bin/dsh-rsi-setup.js' } }))
  await writeFile(join(packageRoot, 'bin', 'dsh-rsi-setup.js'), 'export {}\n')
  await writeFile(join(packageRoot, 'lib', 'rsi-setup.js'), `import { writeFile } from 'node:fs/promises'
export async function runRsiSetup(args) {
  await new Promise(resolve => setTimeout(resolve, 25))
  await writeFile(process.env.SETUP_RESULT, JSON.stringify(args))
}
`)
  const invoke = () => spawnSync('/bin/bash', ['-c',
    'source "$1"; dsh_enhanced_run_profile_setup 0 "$2" assistant source-rsi "$3" --install-local-cohort',
    'setup-test', join(process.cwd(), 'scripts/install/common.sh'), home, checkout], {
    encoding: 'utf8', env: { ...process.env, NODE_PATH: '', PATH: `${bin}:${process.env.PATH ?? ''}`, SETUP_RESULT: output },
  })
  await rm(profile, { recursive: true })
  const initialized = invoke()
  expect(initialized.status, initialized.stderr).toBe(0)
  expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(['--install-local-cohort'])
  expect(existsSync(join(home, 'profiles', 'node_modules'))).toBe(false)
  await rm(output)
  await mkdir(profile)
  await writeFile(join(profile, 'package.json'), '{invalid')
  const invalid = invoke()
  expect(invalid.status).not.toBe(0)
  expect(existsSync(output)).toBe(false)
})

test.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/script'))('DSH 0.2 setup preserves a terminal stdin', async () => {
  const { home, bin, output } = await fixture()
  const command = `PATH=${JSON.stringify(`${bin}:${process.env.PATH ?? ''}`)} SETUP_RESULT=${JSON.stringify(output)} /bin/bash -c 'source scripts/install/common.sh; dsh_enhanced_run_profile_setup 0 ${JSON.stringify(home)} assistant dsh-model-setup --tty'`
  const result = spawnSync('/usr/bin/script', ['-qfc', command, '/dev/null'], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(await readFile(output, 'utf8')).tty).toBe(true)
})
