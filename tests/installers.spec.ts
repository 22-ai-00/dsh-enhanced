import { chmod, link, mkdtemp, mkdir, open, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { parse, stringify } from 'yaml'
import { RECOVERY_CATALOG_DIGEST } from '@dsh-enhanced/assistant-recovery'
import {
  assertEffectiveSupervisedGrowthConfig,
  configureSupervisedGrowthProfilePatch,
} from '../plugins/lark-channel/src/supervised-growth-profile.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installDirectory = join(repoRoot, 'scripts', 'install')
const localInstaller = join(installDirectory, 'install-local.sh')
const npmInstaller = join(installDirectory, 'install-npm.sh')
const restartScript = join(installDirectory, 'restart.sh')
const installerLibrary = join(installDirectory, 'common.sh')
const temporaryRoots: string[] = []
const pinnedInstallerSource = readFileSync(npmInstaller, 'utf8')
const pinnedReleaseRef = pinnedInstallerSource.match(/^DSH_ENHANCED_PINNED_RELEASE_REF='([^']+)'$/mu)?.[1]
const pinnedRemoteCommon = pinnedReleaseRef === undefined ? undefined : spawnSync('git', [
  'show', `${pinnedReleaseRef}:scripts/install/common.sh`,
], {
  cwd: repoRoot,
  encoding: 'buffer',
})
const realBwrapProbe = spawnSync('/usr/bin/bwrap', [
  '--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--', '/bin/true',
], { encoding: 'utf8', timeout: 5_000 })
const realBwrapUsable = realBwrapProbe.status === 0

/**
 * Run an installer entry point.
 *
 * `platform` pins `uname -s` detection the same way {@link runRestart} does, so
 * assertions about a platform-specific resident service (systemd units on
 * Linux, launchd on macOS) stay deterministic on any development host instead
 * of only passing on the CI runner's operating system.
 */
function runInstaller(
  script: string,
  args: readonly string[],
  dshHome: string,
  platform?: string,
  extraEnvironment: Record<string, string | undefined> = {},
) {
  return spawnSync('/bin/bash', [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      DSH_HOME: dshHome,
      ...(platform === undefined ? {} : { DSH_ENHANCED_PLATFORM_OVERRIDE: platform }),
      ...extraEnvironment,
    },
  })
}

function runRestart(args: readonly string[], dshHome: string, platform?: string) {
  return spawnSync('/bin/bash', [restartScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      DSH_HOME: dshHome,
      DSH_ENHANCED_DRY_RUN: '1',
      ...(platform === undefined ? {} : { DSH_ENHANCED_PLATFORM_OVERRIDE: platform }),
    },
  })
}

async function temporaryDshHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-enhanced-installer-'))
  temporaryRoots.push(root)
  return root
}

async function configureExistingLark(dshHome: string, profile = 'web'): Promise<void> {
  const profileDirectory = join(dshHome, 'profiles', profile)
  await mkdir(profileDirectory, { recursive: true })
  await writeFile(join(profileDirectory, 'cordis.patch.yml'), `- id: dsh-enhanced-lark-channel
  config:
    enabled: true
    appId: cli_0123456789abcdef
`, 'utf8')
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf8')
  await chmod(path, 0o755)
}

interface LifecycleFixtureOptions {
  activationFails?: boolean
  managedDependencies?: readonly string[]
  thirdParty?: boolean
  thirdPartyDependency?: boolean
}

interface LifecycleRunOptions {
  activationMarker?: string
  configAfterUpgrade?: string
  packageBlock?: boolean
  packageFails?: boolean
  packageWriteRelative?: string
}

async function lifecycleFixture(options: LifecycleFixtureOptions = {}) {
  const root = await temporaryDshHome()
  const dshHome = join(root, 'home')
  const profileDirectory = join(dshHome, 'profiles', 'web')
  const fakeBin = join(root, 'bin')
  await mkdir(profileDirectory, { recursive: true })
  await mkdir(fakeBin)
  const thirdParty = options.thirdParty ?? false
  const managedDependencies = options.managedDependencies ?? ['personal-assistant']
  const dependencies = Object.fromEntries(managedDependencies.map(name => [`@dsh-enhanced/${name}`, '0.1.0']))
  const managedBundles = managedDependencies.map(name => `@dsh-enhanced/${name}`)
  await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dependencies: {
      ...dependencies,
      ...(options.thirdPartyDependency ? { 'owner-library': '1.0.0' } : {}),
      ...(thirdParty ? { 'owner-plugin': '1.0.0' } : {}),
    },
    dsh: { profile: { bundles: [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...managedBundles,
      ...(thirdParty ? ['owner-plugin'] : []),
    ] } },
  }, null, 2))
  await writeFile(join(profileDirectory, 'cordis.yml'), '[]\n')
  await writeFile(join(profileDirectory, 'cordis.patch.yml'), '- id: owner-custom\n  config: { value: keep }\n')
  await writeFile(join(profileDirectory, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  await writeFile(join(profileDirectory, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await mkdir(join(dshHome, 'assistant-goals'), { recursive: true })
  const databasePath = join(dshHome, 'assistant-goals', 'web.sqlite')
  const database = new DatabaseSync(databasePath)
  database.exec("PRAGMA user_version = 1; CREATE TABLE goals (value TEXT NOT NULL); INSERT INTO goals VALUES ('durable-goal-state');")
  database.close()
  await mkdir(join(dshHome, 'sessions'), { recursive: true })
  await writeFile(join(dshHome, 'sessions', 'owner-session.jsonl'), 'durable-session')
  const dshLog = join(root, 'dsh.log')
  const bwrapLog = join(root, 'bwrap.log')
  const lifecycleTarget = join(root, 'managed-target')
  await mkdir(lifecycleTarget)
  await writeFile(join(lifecycleTarget, 'package.json'), JSON.stringify({
    name: `@dsh-enhanced/${managedDependencies[0] ?? 'personal-assistant'}`,
    version: '0.1.0',
  }))
  const activation = `"${process.execPath}" --input-type=module - "$DSH_HOME/assistant-goals/web.sqlite" <<'NODE'
import { DatabaseSync } from 'node:sqlite'
const database = new DatabaseSync(process.argv[2])
database.exec("PRAGMA user_version = 2; INSERT INTO goals VALUES ('migrated-during-activation');")
database.close()
NODE
${options.activationFails ? "printf 'activation failed\\n' >&2; exit 23" : "printf 'dsh web: http://127.0.0.1:43210\\n'; exit 0"}`
  await writeExecutable(join(fakeBin, 'dsh'), String.raw`#!/bin/bash
set -euo pipefail
{ printf 'CALL'; printf '\t%s' "$@"; printf '\n'; } >> "$LIFECYCLE_DSH_LOG"
if [[ " ${'$'}{1:-} " == ' --version ' ]]; then printf '0.1.2-rc.1\n'; exit 0; fi
if [[ " $* " == *' plugin '* && " $* " == *' add '* ]]; then
  if [[ "$LIFECYCLE_PACKAGE_FAILS" == '1' ]]; then printf 'package update failed\n' >&2; exit 42; fi
  if [[ "$LIFECYCLE_PACKAGE_BLOCK" == '1' ]]; then
    : > "$DSH_HOME/.package-preparation-started"
    while [[ ! -f "$DSH_HOME/.package-preparation-release" ]]; do sleep 0.05; done
  fi
  if [[ -n "$LIFECYCLE_CONFIG_AFTER_UPGRADE" ]]; then
    printf '%s\n' "$LIFECYCLE_CONFIG_AFTER_UPGRADE" > "$DSH_HOME/.lifecycle-dump-config"
  fi
  if [[ -n "$LIFECYCLE_PACKAGE_WRITE_RELATIVE" ]]; then
    printf 'outside-write\n' > "$DSH_HOME/$LIFECYCLE_PACKAGE_WRITE_RELATIVE"
  fi
  printf 'upgraded\n' > "$DSH_HOME/profiles/web/upgraded"
  exit 0
fi
if [[ " $* " == *' plugin '* && " $* " == *' list '* ]]; then
  mkdir -p "$DSH_HOME/profiles/web"
  printf '%s\n' '{"name":"dsh-profile-web","private":true,"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}' > "$DSH_HOME/profiles/web/package.json"
  printf '%s\n' '[]' > "$DSH_HOME/profiles/web/cordis.yml"
  printf '%s\n' '[]' > "$DSH_HOME/profiles/web/cordis.patch.yml"
  exit 0
fi
if [[ " $* " == *' --dump-config '* ]]; then
  if [[ -f "$DSH_HOME/.lifecycle-dump-config" ]]; then cat "$DSH_HOME/.lifecycle-dump-config"; else printf '[]\n'; fi
  exit 0
fi
if [[ " $* " == *' --host 127.0.0.1 --no-open --port 0 '* ]]; then
  : > "$LIFECYCLE_ACTIVATION_MARKER"
  __ACTIVATION__
fi
exit 2
`.replace('__ACTIVATION__', activation))
  await writeExecutable(join(fakeBin, 'pnpm'), `#!/bin/bash
set -euo pipefail
if [[ " \${1:-} " == ' --version ' ]]; then printf '10.0.0\n'; fi
exit 0
`)
  await writeExecutable(join(fakeBin, 'bwrap'), `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const { realpathSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
const separator = args.indexOf('--')
const environment = {}
const controls = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('LIFECYCLE_')))
let stageHome
let logicalHome
for (let index = 0; index < separator; index += 1) {
  if (args[index] === '--setenv') { environment[args[index + 1]] = args[index + 2]; index += 2; continue }
  if (args[index] === '--bind') { stageHome = args[index + 1]; logicalHome = args[index + 2]; index += 2; continue }
  if (args[index] === '--bind-fd') { stageHome = realpathSync('/proc/self/fd/' + args[index + 1]); logicalHome = args[index + 2]; index += 2; continue }
  if (args[index] === '--ro-bind') { index += 2; continue }
  if (args[index] === '--tmpfs' || args[index] === '--proc' || args[index] === '--dev') { index += 1 }
}
if (controls.LIFECYCLE_BWRAP_LOG) appendFileSync(controls.LIFECYCLE_BWRAP_LOG, JSON.stringify(args) + '\\n')
if (separator < 0 || !args.includes('--unshare-all') || args.includes('--share-net') || !stageHome || !logicalHome) {
  process.stderr.write('fake bwrap rejected unsafe or incomplete sandbox arguments\\n')
  process.exit(97)
}
for (const [key, value] of Object.entries(environment)) {
  if (value === logicalHome || value.startsWith(logicalHome + '/')) environment[key] = stageHome + value.slice(logicalHome.length)
}
Object.assign(environment, controls)
for (const key of ['LIFECYCLE_ACTIVATION_MARKER']) {
  const value = environment[key]
  if (value === logicalHome || value.startsWith(logicalHome + '/')) environment[key] = stageHome + value.slice(logicalHome.length)
}
const command = args.slice(separator + 1)
for (let index = 0; index < command.length; index += 1) {
  const value = command[index]
  if (value === logicalHome || value.startsWith(logicalHome + '/')) command[index] = stageHome + value.slice(logicalHome.length)
}
const result = spawnSync(command[0], command.slice(1), { env: environment, encoding: 'buffer' })
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
if (result.error) { process.stderr.write(String(result.error) + '\\n'); process.exit(98) }
process.exit(result.status ?? 99)
`)
  return {
    root, dshHome, profileDirectory, fakeBin, databasePath, dshLog, bwrapLog, lifecycleTarget,
    activationMarker: join(dshHome, '.activation-ran'),
  }
}

function lifecycleEnvironment(dshHome: string, fakeBin: string, options: LifecycleRunOptions = {}) {
  return {
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`, DSH_HOME: dshHome,
    LIFECYCLE_ACTIVATION_MARKER: options.activationMarker ?? join(dshHome, '.activation-ran'),
    LIFECYCLE_BWRAP_LOG: join(dirname(dshHome), 'bwrap.log'),
    LIFECYCLE_CONFIG_AFTER_UPGRADE: options.configAfterUpgrade ?? '',
    LIFECYCLE_DSH_LOG: join(dirname(dshHome), 'dsh.log'),
    LIFECYCLE_PACKAGE_FAILS: options.packageFails ? '1' : '0',
    LIFECYCLE_PACKAGE_BLOCK: options.packageBlock ? '1' : '0',
    LIFECYCLE_PACKAGE_WRITE_RELATIVE: options.packageWriteRelative ?? '',
  }
}

function runLifecycle(args: readonly string[], dshHome: string, fakeBin: string, options: LifecycleRunOptions = {}) {
  return spawnSync('/bin/bash', ['-c', 'source "$1"; shift; dsh_enhanced_profile_lifecycle "$@"',
    'lifecycle-test', installerLibrary, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: lifecycleEnvironment(dshHome, fakeBin, options),
  })
}

function startLifecycle(args: readonly string[], dshHome: string, fakeBin: string, options: LifecycleRunOptions = {}) {
  const child = spawn('/bin/bash', ['-c', 'source "$1"; shift; dsh_enhanced_profile_lifecycle "$@"',
    'lifecycle-test', installerLibrary, ...args], {
    cwd: repoRoot, env: lifecycleEnvironment(dshHome, fakeBin, options),
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  return { child,
    done: new Promise<{ status: number | null; stdout: string; stderr: string }>(resolveDone => {
      child.once('close', status => resolveDone({ status, stdout, stderr }))
    }),
  }
}

function runRecovery(profile: string, dshHome: string, fakeBin: string) {
  return spawnSync('/bin/bash', ['-c', 'source "$1"; dsh_enhanced_recover_profile_lifecycle "$2" "$3" 0',
    'recovery-test', installerLibrary, profile, dshHome], {
    cwd: repoRoot, encoding: 'utf8', env: lifecycleEnvironment(dshHome, fakeBin),
  })
}

function startRecovery(profile: string, dshHome: string, fakeBin: string) {
  const child = spawn('/bin/bash', ['-c', 'source "$1"; dsh_enhanced_recover_profile_lifecycle "$2" "$3" 0',
    'recovery-test', installerLibrary, profile, dshHome], {
    cwd: repoRoot, env: lifecycleEnvironment(dshHome, fakeBin),
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  return {
    child,
    done: new Promise<{ status: number | null; stdout: string; stderr: string }>(resolveDone => {
      child.once('close', status => resolveDone({ status, stdout, stderr }))
    }),
  }
}

async function holdExternalLifecycleLock(path: string) {
  const child = spawn('/usr/bin/python3', ['-c', [
    'import fcntl, os, sys',
    'handle = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)',
    'fcntl.flock(handle, fcntl.LOCK_EX)',
    'sys.stdout.write("LOCKED\\n")',
    'sys.stdout.flush()',
    'sys.stdin.buffer.read()',
  ].join('\n'), path], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`external lock did not become ready: ${stderr}`)), 5_000)
    const inspect = () => {
      if (!stdout.includes('LOCKED\n')) return
      clearTimeout(timeout)
      child.stdout.off('data', inspect)
      resolveReady()
    }
    child.stdout.on('data', inspect)
    child.once('exit', status => {
      if (!stdout.includes('LOCKED\n')) {
        clearTimeout(timeout)
        rejectReady(new Error(`external lock exited with ${status}: ${stderr}`))
      }
    })
  })
  return {
    async release() {
      child.stdin.end()
      await new Promise<void>(resolveClose => child.once('close', () => resolveClose()))
    },
  }
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await readFile(path)
      return
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
  }
  throw new Error(`Timed out waiting for ${path}`)
}

function readLifecycleDatabase(path: string) {
  const database = new DatabaseSync(path, { readOnly: true })
  const userVersion = database.prepare('PRAGMA user_version').get() as { user_version: number }
  const values = database.prepare('SELECT value FROM goals ORDER BY rowid').all() as Array<{ value: string }>
  database.close()
  return { userVersion: userVersion.user_version, values: values.map(({ value }) => value) }
}

async function preservedLifecycleTransactions(dshHome: string): Promise<string[]> {
  const parent = dirname(dshHome)
  const prefix = `${basename(dshHome)}.dsh-enhanced-transaction`
  return (await readdir(parent))
    .filter(name => name === prefix || name.startsWith(`${prefix}.`))
    .map(name => join(parent, name))
    .sort()
}

async function readJsonLines(path: string): Promise<unknown[][]> {
  const source = await readFile(path, 'utf8')
  return source.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown[])
}

type RecoveryState = 'preparing' | 'prepared' | 'validated' | 'original-renamed' | 'swapped' | 'committed' | 'cleanup-started' | 'failed'

interface LifecycleIdentity {
  dev: string
  ino: string
}

interface BoundLifecycleManifest {
  version: 1
  id: string
  homePath: string
  canonicalHome: string
  transactionPath: string
  profile: string
  operation: 'upgrade' | 'uninstall'
  originalIdentity: LifecycleIdentity
  originalProfileDigest: string
  stagedIdentity?: LifecycleIdentity
  stagedProfileDigest?: string
  createdAt: string
  state: RecoveryState
  updatedAt: string
  bindingDigest: string
}

async function lifecycleIdentity(path: string): Promise<LifecycleIdentity> {
  const entry = await stat(path)
  return { dev: String(entry.dev), ino: String(entry.ino) }
}

function lifecycleBinding(manifest: Omit<BoundLifecycleManifest, 'bindingDigest' | 'updatedAt'>) {
  return {
    version: manifest.version,
    id: manifest.id,
    homePath: manifest.homePath,
    canonicalHome: manifest.canonicalHome,
    transactionPath: manifest.transactionPath,
    profile: manifest.profile,
    operation: manifest.operation,
    originalIdentity: manifest.originalIdentity,
    originalProfileDigest: manifest.originalProfileDigest,
    stagedIdentity: manifest.stagedIdentity,
    stagedProfileDigest: manifest.stagedProfileDigest,
    createdAt: manifest.createdAt,
    state: manifest.state,
  }
}

async function writeBoundLifecycleManifest(options: {
  dshHome: string
  originalHome: string
  stagedHome?: string
  state: RecoveryState
  originalProfileDigest?: string
  originalIdentity?: LifecycleIdentity
  stagedIdentity?: LifecycleIdentity
  stagedProfileDigest?: string
}): Promise<BoundLifecycleManifest> {
  const transactionPath = `${options.dshHome}.dsh-enhanced-transaction`
  await mkdir(transactionPath, { recursive: true, mode: 0o700 })
  await chmod(transactionPath, 0o700)
  const createdAt = '2026-09-09T00:00:00.000Z'
  const base = {
    version: 1 as const,
    id: `recovery-${options.state}`,
    homePath: options.dshHome,
    canonicalHome: await realpath(options.dshHome).catch(() => options.dshHome),
    transactionPath,
    profile: 'web',
    operation: 'upgrade' as const,
    originalIdentity: options.originalIdentity ?? await lifecycleIdentity(options.originalHome),
    originalProfileDigest: options.originalProfileDigest ?? createHash('sha256')
      .update(await readFile(join(options.originalHome, 'profiles', 'web', 'package.json')))
      .digest('hex'),
    stagedIdentity: options.stagedIdentity ?? (options.stagedHome === undefined ? undefined : await lifecycleIdentity(options.stagedHome)),
    stagedProfileDigest: options.stagedProfileDigest,
    createdAt,
    state: options.state,
  }
  const manifest: BoundLifecycleManifest = {
    ...base,
    updatedAt: createdAt,
    bindingDigest: createHash('sha256').update(JSON.stringify(lifecycleBinding(base))).digest('hex'),
  }
  await writeFile(join(transactionPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  return manifest
}

const yamlOptions = {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
} as const

async function composeSelectedBundleRows(installerOutput: string): Promise<any[]> {
  const paths = [...new Set([...installerOutput.matchAll(new RegExp(`${repoRoot}/plugins/[a-z0-9-]+`, 'gu'))]
    .map(match => match[0]))]
  const rows: any[] = []
  for (const path of paths) {
    const patch = parse(await readFile(join(path, 'cordis.patch.yml'), 'utf8'), yamlOptions) as any[]
    for (const operation of patch) {
      if (Array.isArray(operation.insert)) rows.push(...operation.insert)
      else if (typeof operation.id === 'string') rows.push(operation)
    }
  }
  return rows
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('one-click installers', () => {
  test('offline upgrade swaps one validated home while preserving custom configuration and durable task state', async () => {
    const f = await lifecycleFixture()
    const patchBefore = await readFile(join(f.profileDirectory, 'cordis.patch.yml'), 'utf8')

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(join(f.profileDirectory, 'upgraded'), 'utf8')).toBe('upgraded\n')
    expect(await readFile(join(f.profileDirectory, 'cordis.patch.yml'), 'utf8')).toBe(patchBefore)
    expect(readLifecycleDatabase(f.databasePath)).toEqual({
      userVersion: 2, values: ['durable-goal-state', 'migrated-during-activation'],
    })
    expect(await readFile(join(f.dshHome, 'sessions', 'owner-session.jsonl'), 'utf8')).toBe('durable-session')
    expect(result.stdout).toContain('profile 生命周期事务完成：upgrade')
    await expect(readFile(`${f.dshHome}.dsh-enhanced-transaction/state`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const sandboxInvocations = await readJsonLines(f.bwrapLog)
    expect(sandboxInvocations).toHaveLength(8)
    for (const invocation of sandboxInvocations) {
      expect(invocation).toContain('--unshare-all')
      expect(invocation).not.toContain('--share-net')
      expect(invocation).toContain('--die-with-parent')
      expect(invocation).toContain('--new-session')
      expect(invocation).toEqual(expect.arrayContaining(['--ro-bind', '/', '/', '--tmpfs', '/tmp']))
      const bind = invocation.indexOf('--bind-fd')
      expect(invocation.slice(bind, bind + 3)).toEqual(['--bind-fd', '3', f.dshHome])
      const dshHomeVariable = invocation.findIndex((value, index) => value === 'DSH_HOME' && invocation[index - 1] === '--setenv')
      expect(invocation[dshHomeVariable + 1]).toBe(f.dshHome)
    }
  })

  test('offline upgrade leaves original home untouched after isolated activation fails', async () => {
    const f = await lifecycleFixture({ activationFails: true })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('原 DSH_HOME 未修改')
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    await expect(readFile(join(f.profileDirectory, 'upgraded'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toHaveLength(1)
    expect(preserved[0]).toBe(`${f.dshHome}.dsh-enhanced-transaction`)
    const preservedManifest = JSON.parse(await readFile(join(preserved[0]!, 'manifest.json'), 'utf8'))
    expect(preservedManifest).toMatchObject({ operation: 'upgrade', profile: 'web', state: 'failed' })
    expect(preservedManifest.failure).toContain('隔离 Host 激活失败')
    const stagedDatabase = join(preserved[0]!, 'staged-home', 'assistant-goals', 'web.sqlite')
    expect(readLifecycleDatabase(stagedDatabase)).toEqual({
      userVersion: 2, values: ['durable-goal-state', 'migrated-during-activation'],
    })
    await expect(readFile(f.activationMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(preserved[0]!, 'staged-home', '.activation-ran'), 'utf8')).toBe('')
  })

  test('offline upgrade leaves the original home untouched when package preparation fails before swap', async () => {
    const f = await lifecycleFixture()
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, {
      activationMarker: f.activationMarker, packageFails: true,
    })

    expect(result.status).toBe(42)
    expect(result.stderr).toContain('原 DSH_HOME 未修改')
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    await expect(readFile(join(f.profileDirectory, 'upgraded'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(f.activationMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
  })

  test('offline uninstall archives the complete old profile and preserves all external durable state', async () => {
    const f = await lifecycleFixture({ thirdParty: false })

    const result = runLifecycle(['uninstall', 'web', f.dshHome, '0'], f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    const current = JSON.parse(await readFile(join(f.profileDirectory, 'package.json'), 'utf8'))
    expect(current.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const archives = await readdir(join(f.dshHome, 'uninstalled-profiles'))
    expect(archives).toHaveLength(1)
    const archived = JSON.parse(await readFile(join(f.dshHome, 'uninstalled-profiles', archives[0]!, 'package.json'), 'utf8'))
    expect(archived.dependencies).toMatchObject({ '@dsh-enhanced/personal-assistant': '0.1.0' })
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 2, values: ['durable-goal-state', 'migrated-during-activation'] })
    expect(await readFile(join(f.dshHome, 'sessions', 'owner-session.jsonl'), 'utf8')).toBe('durable-session')
    const repeated = runLifecycle(['uninstall', 'web', f.dshHome, '0'], f.dshHome, f.fakeBin)
    expect(repeated.status, repeated.stderr).toBe(0)
    expect(repeated.stdout).toContain('没有 @dsh-enhanced/* 顶层依赖')
    expect(await readdir(join(f.dshHome, 'uninstalled-profiles'))).toEqual(archives)
  })

  test('uninstall fails closed without changing a profile that has third-party bundles', async () => {
    const f = await lifecycleFixture({ thirdParty: true })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

    const result = runLifecycle(['uninstall', 'web', f.dshHome, '0'], f.dshHome, f.fakeBin)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/third-party|第三方/u)
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
  })

  test('upgrade fails closed without changing a profile that has a third-party bundle', async () => {
    const f = await lifecycleFixture({ thirdParty: true })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/third-party|第三方/u)
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    await expect(readFile(f.dshLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await preservedLifecycleTransactions(f.dshHome)).toEqual([])
  })

  test('upgrade rejects an ordinary dependency activated as a third-party composed row', async () => {
    const f = await lifecycleFixture({ thirdPartyDependency: true })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, {
      configAfterUpgrade: '- id: owner-local-plugin\n  name: owner-library\n  config:\n    dataDir: /srv/owner-state',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('rejects enabled non-first-party row owner-local-plugin')
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    await expect(readFile(f.activationMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('refuses unbound legacy transaction residue without renaming or deleting unknown homes', async () => {
    const f = await lifecycleFixture()
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    await mkdir(transaction, { mode: 0o700 })
    await writeFile(join(transaction, 'state'), 'swapped\n')
    await rename(f.dshHome, join(transaction, 'original-home'))
    await mkdir(f.dshHome)
    await writeFile(join(f.dshHome, 'failed-new-home'), 'partial')

    const result = runRecovery('web', f.dshHome, f.fakeBin)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/unbound|绑定|未知|manifest/iu)
    expect(await readFile(join(f.dshHome, 'failed-new-home'), 'utf8')).toBe('partial')
    expect(readLifecycleDatabase(join(transaction, 'original-home', 'assistant-goals', 'web.sqlite'))).toEqual({
      userVersion: 1, values: ['durable-goal-state'],
    })
  })

  test.each(['preparing', 'failed'] as const)('bound %s recovery preserves evidence while leaving the original home intact', async state => {
    const f = await lifecycleFixture({ thirdParty: false })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const originalIdentity = await lifecycleIdentity(f.dshHome)
    const originalManifest = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    const stagedHome = join(transaction, 'staged-home')
    await mkdir(stagedHome, { recursive: true })
    await writeFile(join(stagedHome, 'failed-stage-marker'), state)
    await writeBoundLifecycleManifest({ dshHome: f.dshHome, originalHome: f.dshHome, stagedHome, state })

    const result = runRecovery('web', f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('原 DSH_HOME 未修改')
    expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(originalManifest)
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toHaveLength(1)
    expect(preserved[0]).not.toBe(transaction)
    expect(await readFile(join(preserved[0]!, 'staged-home', 'failed-stage-marker'), 'utf8')).toBe(state)
    const manifest = JSON.parse(await readFile(join(preserved[0]!, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ state, originalIdentity })
  })

  test('bound original-renamed recovery restores an absent home from the original backup', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const backupHome = join(transaction, 'original-home')
    const originalIdentity = await lifecycleIdentity(f.dshHome)
    const originalManifest = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    await mkdir(transaction, { mode: 0o700 })
    await rename(f.dshHome, backupHome)
    await writeBoundLifecycleManifest({
      dshHome: f.dshHome, originalHome: backupHome, state: 'original-renamed', originalIdentity,
    })

    const result = runRecovery('web', f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('已恢复原 DSH_HOME')
    expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(originalManifest)
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toHaveLength(1)
    expect(preserved[0]).not.toBe(transaction)
    await expect(readFile(join(preserved[0]!, 'original-home', 'profiles', 'web', 'package.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('bound swapped recovery restores the original and keeps the failed staged home as evidence', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const backupHome = join(transaction, 'original-home')
    const stagedHome = join(transaction, 'staged-home')
    const originalIdentity = await lifecycleIdentity(f.dshHome)
    const originalManifest = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    await mkdir(transaction, { mode: 0o700 })
    await rename(f.dshHome, backupHome)
    await mkdir(stagedHome)
    await mkdir(join(stagedHome, 'profiles', 'web'), { recursive: true })
    await writeFile(join(stagedHome, 'profiles', 'web', 'package.json'), '{"staged":true}\n')
    await writeFile(join(stagedHome, 'staged-marker'), 'failed staged home')
    const stagedIdentity = await lifecycleIdentity(stagedHome)
    await writeBoundLifecycleManifest({
      dshHome: f.dshHome, originalHome: backupHome, stagedHome, state: 'swapped', originalIdentity, stagedIdentity,
    })
    await rename(stagedHome, f.dshHome)

    const result = runRecovery('web', f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('原 DSH_HOME 已恢复')
    expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(originalManifest)
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toHaveLength(1)
    expect(await readFile(join(preserved[0]!, 'failed-home', 'staged-marker'), 'utf8')).toBe('failed staged home')
  })

  test('bound committed recovery removes its original backup and transaction without changing the staged live home', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const backupHome = join(transaction, 'original-home')
    const stagedHome = join(transaction, 'staged-home')
    const originalIdentity = await lifecycleIdentity(f.dshHome)
    await mkdir(transaction, { mode: 0o700 })
    await rename(f.dshHome, backupHome)
    await mkdir(join(stagedHome, 'profiles', 'web'), { recursive: true })
    await writeFile(join(stagedHome, 'profiles', 'web', 'package.json'), '{"staged":true}\n')
    await writeFile(join(stagedHome, 'committed-marker'), 'keep live')
    const stagedIdentity = await lifecycleIdentity(stagedHome)
    const stagedProfileDigest = createHash('sha256')
      .update(await readFile(join(stagedHome, 'profiles', 'web', 'package.json')))
      .digest('hex')
    await writeBoundLifecycleManifest({
      dshHome: f.dshHome, originalHome: backupHome, stagedHome, state: 'committed',
      originalIdentity, stagedIdentity, stagedProfileDigest,
    })
    await rename(stagedHome, f.dshHome)

    const result = runRecovery('web', f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('已完成上次提交后的绑定清理')
    expect(await lifecycleIdentity(f.dshHome)).toEqual(stagedIdentity)
    expect(await readFile(join(f.dshHome, 'committed-marker'), 'utf8')).toBe('keep live')
    expect(await preservedLifecycleTransactions(f.dshHome)).toEqual([])
  })

  test.each([
    ['inode', { inode: true, digest: false }],
    ['digest', { inode: false, digest: true }],
  ] as const)('bound recovery fails closed on an original %s mismatch', async (_kind, mismatch) => {
    const f = await lifecycleFixture({ thirdParty: false })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const markerPath = join(transaction, 'staged-home', 'evidence')
    await mkdir(dirname(markerPath), { recursive: true })
    await writeFile(markerPath, 'untouched evidence')
    const actualIdentity = await lifecycleIdentity(f.dshHome)
    const originalIdentity = mismatch.inode ? { ...actualIdentity, ino: String(BigInt(actualIdentity.ino) + 1n) } : actualIdentity
    await writeBoundLifecycleManifest({
      dshHome: f.dshHome,
      originalHome: f.dshHome,
      stagedHome: dirname(markerPath),
      state: 'failed',
      originalIdentity,
      originalProfileDigest: mismatch.digest ? '0'.repeat(64) : undefined,
    })

    const result = runRecovery('web', f.dshHome, f.fakeBin)

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(mismatch.inode ? /身份未知|拒绝重命名|inode/iu : /摘要不匹配|digest/iu)
    expect(await readFile(markerPath, 'utf8')).toBe('untouched evidence')
    expect(await preservedLifecycleTransactions(f.dshHome)).toEqual([transaction])
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
  })

  test('a concurrent lifecycle operation is refused while preparation holds the home lock and leaves the original untouched', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    const first = startLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { packageBlock: true })
    const stagedHome = join(`${f.dshHome}.dsh-enhanced-transaction`, 'staged-home')
    await waitForFile(join(stagedHome, '.package-preparation-started'))

    const second = startLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)
    const observedSecond = await Promise.race([
      second.done,
      new Promise<undefined>(resolveDelay => setTimeout(resolveDelay, 1_000)),
    ])
    await writeFile(join(stagedHome, '.package-preparation-release'), '')
    const secondResult = observedSecond ?? await second.done
    expect(observedSecond, 'the contender must fail immediately rather than wait for the lock').toBeDefined()
    expect(secondResult.status).not.toBe(0)
    expect(secondResult.stderr).toMatch(/busy|lock|正在|并发|占用/iu)
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })

    const firstResult = await first.done
    expect(firstResult.status, firstResult.stderr).toBe(0)
  })

  test('an externally held lifecycle lock is nonblocking and covers recovery before any residue is moved', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const residueMarker = join(transaction, 'legacy-residue')
    await mkdir(transaction, { mode: 0o700 })
    await writeFile(residueMarker, 'must-not-move')
    const lock = await holdExternalLifecycleLock(`${f.dshHome}.dsh-enhanced-lifecycle.lock`)

    try {
      const recovery = startRecovery('web', f.dshHome, f.fakeBin)
      const result = await Promise.race([
        recovery.done,
        new Promise<undefined>(resolveDelay => setTimeout(resolveDelay, 1_000)),
      ])

      expect(result, 'recovery must fail rather than wait for an externally owned lock').toBeDefined()
      expect(result!.status).not.toBe(0)
      expect(result!.stderr).toMatch(/busy|lock|正在|并发|占用/iu)
      expect(await readFile(residueMarker, 'utf8')).toBe('must-not-move')
      expect(await preservedLifecycleTransactions(f.dshHome)).toEqual([transaction])
    } finally {
      await lock.release()
    }
  })

  test('post-upgrade structural validation rejects a newly introduced external state path before activation or swap', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, {
      configAfterUpgrade: "- id: newly-installed-state\n  name: '@dsh-enhanced/personal-assistant'\n  config:\n    statePath: /srv/newly-installed/state.json",
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('lifecycle configuration rejects newly-installed-state.statePath: resolves outside canonical DSH_HOME')
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    await expect(readFile(f.activationMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toHaveLength(1)
    expect(await readFile(join(preserved[0]!, 'staged-home', '.lifecycle-dump-config'), 'utf8')).toContain('/srv/newly-installed/state.json')
  })

  test('rejects a descendant symlink escape before a staged package command can write outside DSH_HOME', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const outsideDirectory = join(f.root, 'outside')
    const outsideWrite = join(outsideDirectory, 'escape.txt')
    await mkdir(outsideDirectory)
    await symlink(outsideDirectory, join(f.dshHome, 'escape-link'))

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, {
      packageWriteRelative: 'escape-link/escape.txt',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/symbolic|symlink|符号链接/iu)
    await expect(readFile(outsideWrite, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await preservedLifecycleTransactions(f.dshHome)).toEqual([])
  })

  test('rejects a hardlink with a directory entry outside DSH_HOME before the staged package command', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const outsideFile = join(f.root, 'outside-state')
    const insideLink = join(f.dshHome, 'linked-state')
    await writeFile(outsideFile, 'outside must remain unchanged')
    await link(outsideFile, insideLink)

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/hardlink|硬链接|连接到快照外部/iu)
    expect(await readFile(outsideFile, 'utf8')).toBe('outside must remain unchanged')
    expect(await readFile(insideLink, 'utf8')).toBe('outside must remain unchanged')
    await expect(readFile(f.dshLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await preservedLifecycleTransactions(f.dshHome)).toEqual([])
  })

  test.skipIf(!realBwrapUsable)('real bwrap mounts a /tmp staged home by fd at the logical DSH_HOME after /tmp isolation', async () => {
    const root = await temporaryDshHome()
    const logicalHome = join(root, 'logical-home')
    const stagedHome = join(root, 'staged-home')
    await mkdir(stagedHome)
    await writeFile(join(stagedHome, 'mounted-marker'), 'staged')
    const stagedHandle = await open(stagedHome, 'r')

    try {
      const result = spawnSync('/usr/bin/bwrap', [
        '--unshare-all', '--die-with-parent', '--new-session',
        '--ro-bind', '/', '/',
        '--tmpfs', '/tmp', '--tmpfs', '/run',
        '--dir', logicalHome,
        '--bind-fd', '3', logicalHome,
        '--proc', '/proc', '--dev', '/dev',
        '--chdir', '/tmp', '--clearenv',
        '--setenv', 'PATH', '/usr/bin:/bin',
        '--setenv', 'HOME', '/tmp',
        '--setenv', 'TMPDIR', '/tmp',
        '--setenv', 'DSH_HOME', logicalHome,
        '--', '/bin/sh', '-c', 'test "$DSH_HOME" = "$1" && test "$(cat "$DSH_HOME/mounted-marker")" = staged && printf "%s\n" "$DSH_HOME"',
        'bwrap-smoke', logicalHome,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', stagedHandle.fd], timeout: 5_000 })

      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe(`${logicalHome}\n`)
    } finally {
      await stagedHandle.close()
    }
  })

  test('installer upgrade targets only existing managed dependencies and preserves third-party dependencies', async () => {
    const f = await lifecycleFixture({
      managedDependencies: ['personal-assistant', 'assistant-goals'],
      thirdParty: false,
      thirdPartyDependency: true,
    })
    const manifestBefore = JSON.parse(await readFile(join(f.profileDirectory, 'package.json'), 'utf8'))

    const result = runInstaller(localInstaller, [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped', '--dry-run',
    ], f.dshHome, undefined, lifecycleEnvironment(f.dshHome, f.fakeBin))

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('pnpm --dir')
    expect(result.stdout).toContain('install --offline --frozen-lockfile')
    expect(result.stdout).toContain('dsh plugin --profile web add')
    for (const target of [
      join(repoRoot, 'plugins', 'personal-assistant'),
      join(repoRoot, 'plugins', 'assistant-goals'),
    ]) expect(result.stdout).toContain(target)
    for (const absent of ['plugin-control-plane', 'assistant-delivery', 'assistant-web-owner']) {
      expect(result.stdout).not.toContain(join(repoRoot, 'plugins', absent))
    }
    expect(JSON.parse(await readFile(join(f.profileDirectory, 'package.json'), 'utf8'))).toEqual(manifestBefore)
  })

  test('upgrade and uninstall require an existing stopped web or autonomy profile', async () => {
    const dshHome = await temporaryDshHome()
    const profile = join(dshHome, 'profiles', 'web')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), '{}')

    const missingConfirmation = runInstaller(localInstaller, ['--operation', 'upgrade', '--scenario', 'web', '--dry-run'], dshHome)
    expect(missingConfirmation.status).toBe(2)
    expect(missingConfirmation.stderr).toContain('--confirm-dsh-home-stopped')
    const lark = runInstaller(localInstaller, ['--operation', 'upgrade', '--scenario', 'lark', '--confirm-dsh-home-stopped', '--dry-run'], dshHome)
    expect(lark.status).toBe(2)
    expect(lark.stderr).toContain('显式 --scenario web 或 --scenario autonomy')
    const hostChange = runInstaller(localInstaller, ['--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped', '--dsh-version', '0.1.2-rc.1', '--dry-run'], dshHome)
    expect(hostChange.status).toBe(2)
    expect(hostChange.stderr).toContain('不会修改全局 DSH')
  })

  test('lifecycle transactions reject state paths outside the snapshotted DSH_HOME', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'home')
    const fakeBin = join(root, 'bin')
    await mkdir(dshHome)
    await mkdir(fakeBin)
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
printf '%s\n' '- id: custom-state' "  name: '@dsh-enhanced/personal-assistant'" '  config:' '    databasePath: /srv/shared/state.sqlite'
`)

    const result = spawnSync('/bin/bash', ['-c', 'source "$1"; dsh_enhanced_validate_lifecycle_state_paths web "$2"',
      'state-path-test', installerLibrary, dshHome], {
      cwd: repoRoot, encoding: 'utf8', env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('lifecycle configuration rejects custom-state.databasePath: resolves outside canonical DSH_HOME')
  })

  test('lifecycle state-path validation fails closed for escaping dshHomePath expressions', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'home')
    const fakeBin = join(root, 'bin')
    await mkdir(dshHome)
    await mkdir(fakeBin)
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
printf '%s\n' '- id: custom-state' "  name: '@dsh-enhanced/personal-assistant'" '  config:' "    databasePath: !!js dshHomePath('../shared/state.sqlite')"
`)

    const result = spawnSync('/bin/bash', ['-c', 'source "$1"; dsh_enhanced_validate_lifecycle_state_paths web "$2"',
      'state-path-test', installerLibrary, dshHome], {
      cwd: repoRoot, encoding: 'utf8', env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('lifecycle configuration rejects custom-state.databasePath: only a non-empty relative dshHomePath expression is allowed')
  })

  test('lifecycle state-path validation fails closed for default dshHomePath expressions', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'home')
    const fakeBin = join(root, 'bin')
    await mkdir(dshHome)
    await mkdir(fakeBin)
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
printf '%s\n' '- id: custom-state' "  name: '@dsh-enhanced/personal-assistant'" '  config:' '    databasePath: !!js dshHomePath()'
`)

    const result = spawnSync('/bin/bash', ['-c', 'source "$1"; dsh_enhanced_validate_lifecycle_state_paths web "$2"',
      'state-path-test', installerLibrary, dshHome], {
      cwd: repoRoot, encoding: 'utf8', env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('lifecycle configuration rejects custom-state.databasePath: only a non-empty relative dshHomePath expression is allowed')
  })

  test('keeps the shared installer compatible with macOS Bash 3.2 empty-array semantics', async () => {
    const source = await readFile(installerLibrary, 'utf8')

    expect(source).not.toMatch(/\b(?:mapfile|readarray)\b/u)
    expect(source).not.toMatch(/\|\s+(?:LC_ALL=C\s+)?sort -V/u)
    expect(source).toContain('if [[ -n "${selected_slugs[0]+set}" ]]')
    expect(source).toContain('if [[ -n "${add_ons[0]+set}" ]]')
    expect(source).toContain('${overlay_args[@]+"${overlay_args[@]}"}')
  })

  test.skipIf(pinnedRemoteCommon === undefined || pinnedRemoteCommon.status !== 0)('remote bootstrap hash matches its pinned release asset when that tag is available locally', async () => {
    // A shallow checkout may not contain release tags.  The test deliberately
    // skips there instead of using the network; release-version fixture tests
    // separately cover future pin rewriting.
    const pinnedHash = pinnedInstallerSource.match(/^DSH_ENHANCED_PINNED_COMMON_SHA256='([0-9a-f]{64})'$/mu)?.[1]

    expect(pinnedHash).toBe(createHash('sha256').update(pinnedRemoteCommon!.stdout).digest('hex'))
  })

  test('collects an interactive model route before its npm cohort is preflighted', async () => {
    const source = await readFile(installerLibrary, 'utf8')
    const routeSelection = source.indexOf('dsh_enhanced_prompt_model_route model_provider model_name model_base_url model_api model_display_name')
    const cohortPreflight = source.indexOf('dsh_enhanced_resolve_npm_cohort "$plugin_version" "$dry_run"')

    expect(routeSelection).toBeGreaterThan(-1)
    expect(cohortPreflight).toBeGreaterThan(routeSelection)
  })

  test('local installer defaults to the safe core scenario with capability discovery and excludes optional bundles', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, ['--dry-run', '--lark', 'skip'], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('目标 profile：web')
    expect(result.stdout).toContain('部署场景：core')
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'personal-assistant'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'plugin-control-plane'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'lark-channel'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-health'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-heartbeat'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-policy'))
    expect(result.stdout).not.toContain('部署模式：')
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'acp'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'hello'))
    expect(result.stdout).toContain('Agent 工具授权：preserve')
    expect(result.stdout).toContain('权限默认值：保留现有 Settings')
    expect(result.stdout).toContain('立即使用：dsh --profile web')
    expect(result.stdout).not.toContain('dsh-lark-setup')
  })

  test('standard Lark installs automatic preference learning without the supervised operations stack', async () => {
    const dshHome = await temporaryDshHome()
    const result = runInstaller(localInstaller, [
      '--dry-run', '--scenario', 'lark', '--lark', 'skip', '--agent-tools', 'disable',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('部署场景：lark')
    expect(result.stdout).toContain('Agent 工具授权：disable')
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'preference-learning'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-evaluation'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-evolution'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-heartbeat'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-health'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-recovery'))
    expect(result.stdout).toContain(
      `${join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'dsh-lark-setup')} `
      + '--profile web --refresh-agent-policy --disable-agent-tools',
    )
    expect(result.stdout).not.toContain('--install-service')
  })

  test('repairs the legacy Evolution-to-Evaluation bundle closure without expanding Lark into supervised', async () => {
    const dshHome = await temporaryDshHome()
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({
      dependencies: { '@dsh-enhanced/assistant-evolution': '0.1.7' },
      dsh: { profile: { bundles: ['@dsh-enhanced/assistant-evolution'] } },
    }, null, 2), 'utf8')

    const result = runInstaller(localInstaller, [
      '--dry-run', '--scenario', 'lark', '--lark', 'skip',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('旧 profile 含 assistant-evolution 但缺少 assistant-evaluation')
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-evaluation'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-heartbeat'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-health'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-recovery'))
  })

  test('explicit standard is byte-for-byte the default dry-run and does not mount Evolution', async () => {
    const implicitHome = await temporaryDshHome()
    const explicitHome = await temporaryDshHome()

    const implicit = runInstaller(localInstaller, ['--dry-run', '--lark', 'skip'], implicitHome)
    const explicit = runInstaller(localInstaller, ['--dry-run', '--mode', 'standard', '--lark', 'skip'], explicitHome)

    expect(implicit.status, implicit.stderr).toBe(0)
    expect(explicit.status, explicit.stderr).toBe(0)
    expect(explicit.stdout.replaceAll(explicitHome, '<DSH_HOME>')).toBe(
      implicit.stdout.replaceAll(implicitHome, '<DSH_HOME>'),
    )
    expect(explicit.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-evolution'))
    expect(explicit.stdout).not.toContain('dsh-supervised-growth-setup')
  })

  test('npm installer tracks the latest DSH and applies one release selector to every published bundle', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(npmInstaller, [
      '--dry-run', '--lark', 'skip', '--profile', 'personal-web', '--plugin-version', '0.2.0',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('目标 profile：personal-web')
    expect(result.stdout).toContain('@deepseek-ai/dsh@latest')
    expect(result.stdout).toContain('@dsh-enhanced/personal-assistant@0.2.0')
    expect(result.stdout).toContain('@dsh-enhanced/plugin-control-plane@0.2.0')
    expect(result.stdout).not.toContain('@dsh-enhanced/lark-channel@0.2.0')
    expect(result.stdout).not.toContain('@dsh-enhanced/acp@')
    expect(result.stdout).not.toContain('@dsh-enhanced/hello@')
  })

  test('npm cohort preflight resolves latest once from the personal-assistant anchor and verifies every bundle', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'npm.log')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf '%s\\n' "$*" >> "$NPM_LOG"
case "$1" in
  view)
    case "$2" in
      @dsh-enhanced/personal-assistant@latest|@dsh-enhanced/personal-assistant@1.4.0|@dsh-enhanced/plugin-control-plane@1.4.0|@dsh-enhanced/traex-acp-provider@1.4.0)
        printf '%s\\n' '"1.4.0"'
        ;;
      *) exit 9 ;;
    esac
    ;;
  *) exit 9 ;;
esac
`)

    const result = spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_resolve_npm_cohort "$2" "$3" personal-assistant plugin-control-plane traex-acp-provider; printf "resolved=%s\\n" "$DSH_ENHANCED_RESOLVED_PLUGIN_VERSION"',
      'installer-test', installerLibrary, 'latest', '0',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_LOG: logPath },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('resolved=1.4.0')
    expect(await readFile(logPath, 'utf8')).toBe([
      'view @dsh-enhanced/personal-assistant@latest version --json',
      'view @dsh-enhanced/personal-assistant@1.4.0 version --json',
      'view @dsh-enhanced/plugin-control-plane@1.4.0 version --json',
      'view @dsh-enhanced/traex-acp-provider@1.4.0 version --json',
      '',
    ].join('\n'))
  })

  test('npm cohort preflight rejects a partial publication before any profile command can run', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'npm.log')
    const profileLogPath = join(root, 'profile.log')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf '%s\\n' "$*" >> "$NPM_LOG"
case "$2" in
  @dsh-enhanced/personal-assistant@latest|@dsh-enhanced/personal-assistant@1.4.0|@dsh-enhanced/plugin-control-plane@1.4.0)
    printf '%s\\n' '"1.4.0"'
    ;;
  @dsh-enhanced/assistant-delivery@1.4.0)
    printf '%s\\n' '"1.3.9"'
    ;;
  *) exit 9 ;;
esac
`)

    const result = spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_resolve_npm_cohort latest 0 personal-assistant plugin-control-plane assistant-delivery || exit $?; printf profile-mutated >> "$PROFILE_LOG"',
      'installer-test', installerLibrary,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_LOG: logPath, PROFILE_LOG: profileLogPath },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('@dsh-enhanced/assistant-delivery@1.4.0')
    await expect(readFile(profileLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('npm cohort preflight resolves the same anchor again on a repeated install', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'npm.log')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf '%s\\n' "$*" >> "$NPM_LOG"
printf '%s\\n' '"1.4.0"'
`)

    const result = spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_resolve_npm_cohort latest 0 personal-assistant plugin-control-plane && dsh_enhanced_resolve_npm_cohort latest 0 personal-assistant plugin-control-plane',
      'installer-test', installerLibrary,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_LOG: logPath },
    })

    expect(result.status, result.stderr).toBe(0)
    expect((await readFile(logPath, 'utf8')).match(/@latest version --json/g)?.length).toBe(2)
    expect((await readFile(logPath, 'utf8')).match(/@1\.4\.0 version --json/g)?.length).toBe(4)
  })

  test('npm cohort preflight keeps an explicit exact version and makes dry-run registry-free', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'npm.log')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf '%s\\n' "$*" >> "$NPM_LOG"
case "$2" in
  @dsh-enhanced/personal-assistant@1.4.0|@dsh-enhanced/plugin-control-plane@1.4.0) printf '%s\\n' '"1.4.0"' ;;
  *) exit 9 ;;
esac
`)

    const explicit = spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_resolve_npm_cohort 1.4.0 0 personal-assistant plugin-control-plane; printf "resolved=%s\\n" "$DSH_ENHANCED_RESOLVED_PLUGIN_VERSION"',
      'installer-test', installerLibrary,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_LOG: logPath },
    })
    const dryRun = spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_resolve_npm_cohort latest 1 personal-assistant plugin-control-plane; printf "resolved=%s\\n" "$DSH_ENHANCED_RESOLVED_PLUGIN_VERSION"',
      'installer-test', installerLibrary,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_LOG: logPath },
    })
    const environmentDefault = spawnSync('/bin/bash', [
      npmInstaller, '--dry-run', '--lark', 'skip',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        DSH_HOME: join(root, 'dsh-home'),
        DSH_ENHANCED_VERSION: '1.4.0',
        NPM_LOG: logPath,
      },
    })

    expect(explicit.status, explicit.stderr).toBe(0)
    expect(explicit.stdout).toContain('resolved=1.4.0')
    expect(await readFile(logPath, 'utf8')).toContain('view @dsh-enhanced/personal-assistant@1.4.0 version --json')
    expect(dryRun.status, dryRun.stderr).toBe(0)
    expect(dryRun.stdout).toContain('resolved=<npm-anchor:latest>')
    expect(dryRun.stdout).toContain('不会访问 npm registry')
    expect(environmentDefault.status, environmentDefault.stderr).toBe(0)
    expect(environmentDefault.stdout).toContain('@dsh-enhanced/personal-assistant@1.4.0')
    expect((await readFile(logPath, 'utf8')).match(/\n/g)?.length).toBe(3)
  })

  test('npm cohort preflight rejects malformed registry data and unsafe selectors without running a command', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'npm.log')
    const markerPath = join(root, 'selector-ran')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf '%s\\n' "$*" >> "$NPM_LOG"
printf '%s\\n' '{not-json'
`)

    const malformed = spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_resolve_npm_cohort latest 0 personal-assistant',
      'installer-test', installerLibrary,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_LOG: logPath },
    })
    const unsafe = spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_resolve_npm_cohort "latest; touch $2" 0 personal-assistant',
      'installer-test', installerLibrary, markerPath,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_LOG: logPath },
    })

    expect(malformed.status).toBe(1)
    expect(malformed.stderr).toContain('无效的版本数据')
    expect(unsafe.status).toBe(2)
    expect(unsafe.stderr).toContain('不支持 range')
    await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(logPath, 'utf8')).toBe('view @dsh-enhanced/personal-assistant@latest version --json\n')
  })

  test('npm supervised dry-run describes one unresolved anchor cohort for every required bundle', async () => {
    const dshHome = await temporaryDshHome()
    const installer = await readFile(npmInstaller, 'utf8')
    const release = installer.match(/^DSH_ENHANCED_PINNED_RELEASE_REF='v([^']+)'$/mu)?.[1]
    expect(release).toMatch(/^\d+\.\d+\.\d+$/u)

    const result = runInstaller(npmInstaller, [
      '--dry-run', '--scenario', 'supervised', '--lark', 'configure',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    const selected = [...result.stdout.matchAll(/@dsh-enhanced\/([a-z0-9-]+)@([^\s]+)/gu)]
    expect(selected.length).toBeGreaterThan(0)
    expect(result.stdout).toContain('npm cohort（dry-run）：将先解析 @dsh-enhanced/personal-assistant@latest 的精确版本')
    expect(result.stdout).toContain('<npm-anchor:latest>')
    const slugs = new Set(selected.map(match => match[1]))
    for (const required of [
      'personal-assistant', 'assistant-delivery', 'assistant-evaluation',
      'assistant-evolution', 'assistant-growth-experiments', 'preference-learning', 'assistant-heartbeat',
      'assistant-health', 'assistant-recovery', 'lark-channel',
    ]) expect(slugs.has(required), `missing ${required}`).toBe(true)
    expect(result.stdout).toContain('dsh-supervised-growth-setup --profile web --timeout-ms 300000')
  })

  test('npm installer with its sibling common uses the source verified host range', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(npmInstaller, [
      '--dry-run', '--lark', 'skip', '--dsh-version', '0.1.0-rc.8',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('超出 dsh-enhanced 已验证范围 >=0.1.2-rc.1 <0.2.0')
  })

  test('remote npm installer exports the verified range paired with its pinned common', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const remoteCommon = join(root, 'common.sh')
    await mkdir(fakeBin, { recursive: true })
    await writeFile(remoteCommon, [
      '#!/usr/bin/env bash',
      'dsh_enhanced_install() {',
      "  printf 'remote-range=%s\\n' \"$DSH_ENHANCED_VERIFIED_HOST_RANGE\"",
      '}',
      '',
    ].join('\n'), 'utf8')
    await writeExecutable(join(fakeBin, 'curl'), `#!/bin/bash
cp "$REMOTE_COMMON" "$4"
`)
    const commonHash = createHash('sha256').update(await readFile(remoteCommon)).digest('hex')
    const installer = await readFile(npmInstaller, 'utf8')
    const releaseManifest = JSON.parse(await readFile(join(repoRoot, 'release-manifest.json'), 'utf8'))
    const pinnedRange = installer.match(
      /^DSH_ENHANCED_PINNED_VERIFIED_HOST_RANGE='([^']+)'$/mu,
    )?.[1]
    expect(pinnedRange).toBe(releaseManifest.current.verifiedHostRange)

    const result = spawnSync('/bin/bash', ['-s', '--', '--dry-run'], {
      cwd: root,
      encoding: 'utf8',
      input: installer,
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        DSH_HOME: join(root, 'dsh-home'),
        DSH_ENHANCED_INSTALL_BASE_URL: 'https://installer.invalid/v0.1.24',
        DSH_ENHANCED_INSTALL_COMMON_SHA256: commonHash,
        REMOTE_COMMON: remoteCommon,
      },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`remote-range=${pinnedRange}`)
    expect(result.stdout).not.toContain('remote-range=>=0.1.2-rc.1 <0.2.0')
  })

  test('refuses incompatible stored permission defaults before changing the installation', async () => {
    for (const preset of ['read-only', 'unrecognized-local-preset']) {
      const dshHome = await temporaryDshHome()
      const settingsPath = join(dshHome, 'settings.yaml')
      await writeFile(settingsPath, `permission:\n  defaultPreset: ${preset}\n`, 'utf8')
      const before = await readFile(settingsPath, 'utf8')

      const result = runInstaller(localInstaller, ['--dry-run', '--lark', 'skip'], dshHome)

      expect(result.status).toBe(2)
      expect(result.stderr).toContain(`permission.defaultPreset=${preset}`)
      expect(result.stderr).toContain('不会覆盖用户设置')
      expect(result.stdout).not.toContain('dsh plugin')
      expect(await readFile(settingsPath, 'utf8')).toBe(before)
    }
  })

  test('preserves every supported stored permission default', async () => {
    for (const preset of ['workspace-write', 'auto', 'danger-full-access']) {
      const dshHome = await temporaryDshHome()
      const settingsPath = join(dshHome, 'settings.yaml')
      await writeFile(settingsPath, `permission:\n  defaultPreset: ${preset}\n`, 'utf8')
      const before = await readFile(settingsPath, 'utf8')

      const result = runInstaller(localInstaller, ['--dry-run', '--lark', 'skip'], dshHome)

      expect(result.status, result.stderr).toBe(0)
      expect(await readFile(settingsPath, 'utf8')).toBe(before)
    }
  })

  test('Recovery README primary command installs every activator dependency then invokes it after Lark onboarding', async () => {
    const dshHome = await temporaryDshHome()
    const readme = await readFile(join(repoRoot, 'plugins', 'assistant-recovery', 'README.md'), 'utf8')
    const documentedCommand = readme.match(/^\.\/scripts\/install\/install-local\.sh --scenario supervised --lark configure$/mu)?.[0]
    expect(documentedCommand).toBeDefined()
    const [, ...documentedArgs] = documentedCommand!.split(/\s+/u)

    const result = runInstaller(localInstaller, [
      '--dry-run', ...documentedArgs,
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('部署模式：supervised-growth')
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'personal-assistant'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-delivery'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'lark-channel'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-evolution'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-evaluation'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-growth-experiments'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'preference-learning'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-heartbeat'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-health'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-recovery'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'traex-acp-provider'))
    expect(result.stdout).toContain('dsh-lark-setup --profile web')
    expect(result.stdout).toContain('dsh-supervised-growth-setup --profile web --timeout-ms 300000')
    expect(result.stdout).not.toContain('overlay：未应用')
  })

  test('supervised-growth installs TraeX only when explicitly requested', async () => {
    const dshHome = await temporaryDshHome()
    const result = runInstaller(localInstaller, [
      '--dry-run', '--mode', 'supervised-growth', '--lark', 'configure', '--with', 'traex',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'traex-acp-provider'))
  })

  test('selected supervised bundles compose into a real effective tree accepted by the activator', async () => {
    const dshHome = await temporaryDshHome()
    const result = runInstaller(localInstaller, [
      '--dry-run', '--mode', 'supervised-growth', '--lark', 'configure',
    ], dshHome)
    expect(result.status, result.stderr).toBe(0)

    const installedRows = await composeSelectedBundleRows(result.stdout)
    const lark = installedRows.find(row => row.id === 'dsh-enhanced-lark-channel')
    expect(lark).toBeDefined()
    lark.config = { ...lark.config, enabled: true, account: 'primary', tenant: 'personal' }
    const effectiveBefore = stringify(installedRows)
    const binding = {
      id: 'binding-owner-dm',
      conversation: { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'oc_owner' },
      principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_owner' },
      workspace: join(dshHome, 'assistant-workspace'),
      agentPreset: 'standard',
      sessionId: 'session-owner', generation: 1, policyRef: 'owner-dm', status: 'active',
      createdAt: 1, updatedAt: 1, version: 1,
    } as const
    const overlay = parse(configureSupervisedGrowthProfilePatch({
      profilePatch: '[]\n', effectiveConfig: effectiveBefore, dshHome, binding,
      activationState: 'preview',
      activationNonce: 'installer-compose-preview',
      recoveryCatalogDigest: RECOVERY_CATALOG_DIGEST,
    }), yamlOptions) as any[]
    const composed = new Map(installedRows.map(row => [row.id, row]))
    for (const row of overlay) composed.set(row.id, row)

    expect(assertEffectiveSupervisedGrowthConfig({
      effectiveConfig: stringify([...composed.values()]), dshHome, binding,
      activationState: 'preview',
      activationNonce: 'installer-compose-preview',
      recoveryCatalogDigest: RECOVERY_CATALOG_DIGEST,
    })).toMatchObject({
      workspace: join(dshHome, 'assistant-workspace'),
      agentPreset: 'standard',
      activationState: 'preview',
      automationId: 'recovery:supervised-growth',
    })
  })

  test('supervised-growth passes an explicit acknowledgement only to its activator', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--mode', 'supervised-growth', '--lark', 'configure', '--ack-existing-automations',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('dsh-supervised-growth-setup --profile web --timeout-ms 300000 --ack-existing-automations')
  })

  test('supervised-growth refuses to run without an owner onboarding path', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--mode', 'supervised-growth', '--lark', 'skip',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('supervised-growth 需要飞书 onboarding')
    expect(result.stdout).not.toContain('dsh plugin')
  })

  test('rejects an unknown deployment mode before planning installation', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--mode', 'unbounded', '--lark', 'skip',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--mode 只能是 standard 或 supervised-growth')
    expect(result.stdout).not.toContain('dsh plugin')
  })

  test('matches npm SemVer precedence and excludes prereleases without a same-core comparator', () => {
    const result = spawnSync('/bin/bash', [
      '-c', [
        'source "$1"',
        'dsh_enhanced_version_ge 0.1.0-rc.8 0.1.0-rc.7',
        '! dsh_enhanced_version_ge 0.1.0-rc.7 0.1.0-rc.8',
        'dsh_enhanced_version_ge 0.1.0 0.1.0-rc.8',
        '! dsh_enhanced_version_ge 0.1.0-rc.8 0.1.0',
        'dsh_enhanced_version_ge 0.1.2-rc.1 0.1.0-rc.8',
        'dsh_enhanced_version_ge 0.1.2-rc.10 0.1.2-rc.2',
        '! dsh_enhanced_version_ge 0.1.2-rc.2 0.1.2-rc.10',
        'dsh_enhanced_version_ge 0.1.2-rc.beta 0.1.2-rc.1',
        '! dsh_enhanced_version_ge 0.1.2-rc.1 0.1.2-rc.beta',
        'dsh_enhanced_version_ge 0.1.2-rc.1.0 0.1.2-rc.1',
        '! dsh_enhanced_version_ge 0.1.2-rc.1 0.1.2-rc.1.0',
        'dsh_enhanced_version_ge 0.1.2+build.2 0.1.2+build.1',
        'dsh_enhanced_version_ge 0.1.2+build.1 0.1.2+build.2',
        "dsh_enhanced_version_in_range 0.1.2-rc.1 '>=0.1.2-rc.1 <0.2.0'",
        "dsh_enhanced_version_in_range 0.1.2-rc.2 '>=0.1.2-rc.1 <0.2.0'",
        "dsh_enhanced_version_in_range 0.1.2-rc.1.0 '>=0.1.2-rc.1 <0.2.0'",
        "dsh_enhanced_version_in_range 0.1.2 '>=0.1.2-rc.1 <0.2.0'",
        "dsh_enhanced_version_in_range 0.1.2+build.1 '>=0.1.2-rc.1 <0.2.0'",
        "dsh_enhanced_version_in_range 0.1.3 '>=0.1.2-rc.1 <0.2.0'",
        "! dsh_enhanced_version_in_range 0.1.2-alpha.9 '>=0.1.2-rc.1 <0.2.0'",
        "! dsh_enhanced_version_in_range 0.1.2-rc.0 '>=0.1.2-rc.1 <0.2.0'",
        "! dsh_enhanced_version_in_range 0.1.3-alpha.1 '>=0.1.2-rc.1 <0.2.0'",
        "! dsh_enhanced_version_in_range 0.2.0-alpha.1 '>=0.1.2-rc.1 <0.2.0'",
        "! dsh_enhanced_version_in_range 0.2.0 '>=0.1.2-rc.1 <0.2.0'",
      ].join('\n'),
      'installer-test', installerLibrary,
    ], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
  })

  test('resolves latest but preserves an installed newer DSH version', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.1.3\n'; fi
`)
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf 'npm %s\n' "$*" >> "$INSTALL_LOG"
if [[ "$*" == 'view @deepseek-ai/dsh dist-tags.latest' ]]; then printf '0.1.2-rc.1\n'; fi
`)

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_ensure_dsh latest 0 0',
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:/usr/bin:/bin`, INSTALL_LOG: logPath },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('DSH latest 已解析为：0.1.2-rc.1')
    expect(result.stdout).toContain('保留现有版本，避免降级')
    expect(await readFile(logPath, 'utf8')).toBe('npm view @deepseek-ai/dsh dist-tags.latest\n')
  })

  test('requires explicit acknowledgement for a host outside the verified range', async () => {
    const dshHome = await temporaryDshHome()
    const blocked = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--dsh-version', '0.1.0-rc.8',
    ], dshHome)
    expect(blocked.status).toBe(2)
    expect(blocked.stderr).toContain('超出 dsh-enhanced 已验证范围 >=0.1.2-rc.1 <0.2.0')
    expect(blocked.stderr).toContain('--ack-unverified-host')
    expect(blocked.stdout).not.toContain('dsh plugin')

    const acknowledged = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--dsh-version', '0.1.0-rc.8', '--ack-unverified-host',
    ], dshHome)
    expect(acknowledged.status, acknowledged.stderr).toBe(0)
    expect(acknowledged.stderr).toContain('已确认继续使用未经验证的 DSH host 版本')
    expect(acknowledged.stdout).toContain('@deepseek-ai/dsh@0.1.0-rc.8')
  })

  test('local installer replaces an incompatible DSH and executes build, install, and validation', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'dsh-home')
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    const setupDirectory = join(dshHome, 'profiles', 'web', 'node_modules', '.bin')
    await mkdir(setupDirectory, { recursive: true })
    await writeExecutable(join(setupDirectory, 'dsh-lark-setup'), `#!/bin/bash
printf 'lark-setup %s\n' "$*" >> "$INSTALL_LOG"
`)
    await writeExecutable(join(fakeBin, 'node'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf 'v24.7.0\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.0.0\\n'; exit 0; fi
printf 'dsh %s\\n' "$*" >> "$INSTALL_LOG"
`)
    await writeExecutable(join(fakeBin, 'dsh-new'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.1.2-rc.1\\n'; exit 0; fi
printf 'dsh %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "$*" == *'--no-open --port 0'* ]]; then
  printf 'dsh web: http://127.0.0.1:43210\\n'
  exit 0
fi
`)
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf 'npm %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "$*" == 'view @deepseek-ai/dsh dist-tags.latest' ]]; then printf '0.1.2-rc.1\\n'; exit 0; fi
if [[ "\${1:-}" == 'prefix' ]]; then printf '%s\\n' "$FAKE_PREFIX"; exit 0; fi
if [[ "$*" == 'install --global @deepseek-ai/dsh@0.1.2-rc.1' ]]; then
  cp "$FAKE_BIN/dsh-new" "$FAKE_BIN/dsh"
  chmod 755 "$FAKE_BIN/dsh"
fi
`)
    await writeExecutable(join(fakeBin, 'pnpm'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '11.7.0\\n'; exit 0; fi
printf 'pnpm %s\\n' "$*" >> "$INSTALL_LOG"
`)

    const result = spawnSync('/bin/bash', [localInstaller, '--lark', 'skip'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        DSH_HOME: dshHome,
        INSTALL_LOG: logPath,
        FAKE_BIN: fakeBin,
        FAKE_PREFIX: root,
      },
    })

    expect(result.status, result.stderr).toBe(0)
    const log = await readFile(logPath, 'utf8')
    expect(log).toContain('npm install --global @deepseek-ai/dsh@0.1.2-rc.1')
    expect(log).toContain('pnpm install')
    expect(log).toContain('pnpm build')
    expect(log).toContain('dsh plugin --profile web add')
    expect(log).toContain('dsh --profile web --dump-config')
    expect(log).toContain('dsh --profile web --host 127.0.0.1 --no-open --port 0')
    expect(log).not.toContain('lark-setup')
  })

  test('fails before Feishu onboarding when a real activation probe reports a pending service', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'dsh-home')
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
    await writeFile(join(dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({
      dependencies: {
        '@dsh-enhanced/assistant-evolution': '0.1.7',
        '@dsh-enhanced/assistant-evaluation': '0.1.7',
      },
    }, null, 2), 'utf8')
    await writeExecutable(join(fakeBin, 'node'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf 'v24.7.0\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
if [[ "$*" == 'view @deepseek-ai/dsh dist-tags.latest' ]]; then printf '0.1.2-rc.1\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'pnpm'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '11.7.0\\n'; exit 0; fi
printf 'pnpm %s\\n' "$*" >> "$INSTALL_LOG"
`)
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.1.2-rc.1\\n'; exit 0; fi
printf 'dsh %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "$*" == *'--no-open --port 0'* ]]; then
  printf '%s\\n' 'Error: dsh: plugin tree failed to load: dsh: 1 entry did not activate' >&2
  printf '%s\\n' '@dsh-enhanced/assistant-evolution: pending (waiting for service: assistantEvaluation)' >&2
  exit 1
fi
if [[ "\${1:-}" == 'plugin' ]]; then
  bin="$DSH_HOME/profiles/web/node_modules/.bin"
  mkdir -p "$bin"
  cat > "$bin/dsh-lark-setup" <<'EOF'
#!/bin/bash
printf 'lark-setup %s\\n' "$*" >> "$INSTALL_LOG"
EOF
  chmod 755 "$bin/dsh-lark-setup"
fi
`)

    const result = spawnSync('/bin/bash', [
      localInstaller, '--scenario', 'lark', '--lark', 'skip', '--no-service', '--yes',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        DSH_HOME: dshHome,
        INSTALL_LOG: logPath,
      },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('waiting for service: assistantEvaluation')
    expect(result.stderr).toContain('尚未继续飞书授权、凭据写入或常驻服务启动')
    const log = await readFile(logPath, 'utf8')
    expect(log).toContain('--no-open --port 0')
    expect(log).not.toContain('lark-setup')
    expect(log).not.toContain('systemctl --user show-environment')
  })

  test('supervised-growth invokes the installed activator only after the installed Lark setup completes', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'dsh-home')
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await configureExistingLark(dshHome)
    await writeExecutable(join(fakeBin, 'node'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf 'v24.7.0\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
if [[ "$*" == 'view @deepseek-ai/dsh dist-tags.latest' ]]; then printf '0.1.2-rc.1\\n'; exit 0; fi
if [[ "\${1:-}" == 'prefix' ]]; then printf '%s\\n' "$FAKE_PREFIX"; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'pnpm'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '11.7.0\\n'; exit 0; fi
printf 'pnpm %s\\n' "$*" >> "$INSTALL_LOG"
`)
    await writeExecutable(join(fakeBin, 'loginctl'), `#!/bin/bash
printf 'loginctl %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "\${1:-}" == 'show-user' ]]; then printf 'yes\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "\${1:-}" == '--user' && "\${2:-}" == 'show' ]]; then
  printf '%s\\n' 'ActiveState=active' 'SubState=running' 'NRestarts=0' 'ExecMainStatus=0'
fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.1.2-rc.1\\n'; exit 0; fi
printf 'dsh %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "$*" == *'--no-open --port 0'* ]]; then
  printf 'dsh web: http://127.0.0.1:43210\\n'
  exit 0
fi
if [[ "\${1:-}" == 'plugin' ]]; then
  bin="$DSH_HOME/profiles/web/node_modules/.bin"
  mkdir -p "$bin"
  cat > "$bin/dsh-lark-setup" <<'EOF'
#!/bin/bash
printf 'lark-setup %s\\n' "$*" >> "$INSTALL_LOG"
EOF
  cat > "$bin/dsh-supervised-growth-setup" <<'EOF'
#!/bin/bash
printf 'supervised-setup %s\\n' "$*" >> "$INSTALL_LOG"
printf 'supervised growth activated\\n'
EOF
  chmod 755 "$bin/dsh-lark-setup" "$bin/dsh-supervised-growth-setup"
fi
`)

    const result = spawnSync('/bin/bash', [localInstaller, '--mode', 'supervised-growth', '--lark', 'keep', '--yes'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        DSH_HOME: dshHome,
        INSTALL_LOG: logPath,
        FAKE_PREFIX: root,
        DSH_ENHANCED_SERVICE_STABILITY_SECONDS: '0',
        // The fake bin stubs systemd tooling, so pin the detected platform
        // instead of inheriting the host's own `uname -s`.
        DSH_ENHANCED_PLATFORM_OVERRIDE: 'Linux',
      },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('supervised growth activated')
    const log = await readFile(logPath, 'utf8')
    expect(log).toContain('systemctl --user show-environment')
    expect(log).toContain('systemctl --user is-active --quiet dsh-profile-web.service')
    expect(log).toContain('systemctl --user show dsh-profile-web.service')
    expect(log).toContain('loginctl show-user')
    expect(log).not.toContain('--no-open --port 0')
    const larkSetup = log.indexOf('lark-setup --profile web --install-service')
    const activator = log.indexOf('supervised-setup --profile web --timeout-ms 300000')
    const serviceDoctor = log.indexOf('systemctl --user is-active --quiet dsh-profile-web.service')
    expect(larkSetup).toBeGreaterThanOrEqual(0)
    expect(activator).toBeGreaterThan(larkSetup)
    expect(serviceDoctor).toBeGreaterThan(activator)
  })

  test('Linux service stability verification stops a restart loop and reports its journal', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const commandLog = join(root, 'commands.log')
    const showCount = join(root, 'show-count')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "\${1:-}" == '--user' && "\${2:-}" == 'show' ]]; then
  count=0
  if [[ -f "$SHOW_COUNT" ]]; then count="$(cat "$SHOW_COUNT")"; fi
  count=$((count + 1))
  printf '%s' "$count" > "$SHOW_COUNT"
  if [[ "$count" == '1' ]]; then restarts=0; else restarts=1; fi
  printf 'ActiveState=active\\nSubState=running\\nNRestarts=%s\\nExecMainStatus=0\\n' "$restarts"
fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'journalctl'), `#!/bin/bash
printf 'journalctl %s\\n' "$*" >> "$COMMAND_LOG"
printf '%s\\n' 'simulated DSH activation failure'
`)

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_verify_linux_service_stability web',
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        COMMAND_LOG: commandLog,
        SHOW_COUNT: showCount,
        DSH_ENHANCED_SERVICE_STABILITY_SECONDS: '0',
      },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('restarts=0->1')
    expect(result.stderr).toContain('simulated DSH activation failure')
    expect(result.stderr).toContain('已停止该服务以避免无限重启')
    const log = await readFile(commandLog, 'utf8')
    expect(log).toContain('systemctl --user show dsh-profile-web.service')
    expect(log).toContain('journalctl --user -u dsh-profile-web.service -n 80 --no-pager')
    expect(log).toContain('systemctl --user stop dsh-profile-web.service')
  })

  test('checks TraeX login before changing its global default or restarting the managed Lark service', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'dsh-home')
    const fakeBin = join(root, 'bin')
    const commandLog = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await configureExistingLark(dshHome)
    const originalSettings = 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n'
    await writeFile(join(dshHome, 'settings.yaml'), originalSettings, 'utf8')
    await writeExecutable(join(fakeBin, 'node'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf 'v24.7.0\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
if [[ "$*" == 'view @deepseek-ai/dsh dist-tags.latest' ]]; then printf '0.1.2-rc.1\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'pnpm'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '11.7.0\\n'; exit 0; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'loginctl'), `#!/bin/bash
if [[ "\${1:-}" == 'show-user' ]]; then printf 'yes\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\\n' "$*" >> "$COMMAND_LOG"
exit 0
`)
    await writeExecutable(join(fakeBin, 'traex'), `#!/bin/bash
if [[ "\${1:-}" == 'login' && "\${2:-}" == 'status' ]]; then
  printf '%s\\n' 'not logged in'
  exit 1
fi
exit 1
`)
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.1.2-rc.1\\n'; exit 0; fi
printf 'dsh %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$*" == *'--dump-config'* ]]; then
  printf '%s\\n' "name: '@dsh-enhanced/traex-acp-provider'"
fi
if [[ "\${1:-}" == 'plugin' ]]; then
  bin="$DSH_HOME/profiles/web/node_modules/.bin"
  mkdir -p "$bin"
  cat > "$bin/dsh-lark-setup" <<'EOF'
#!/bin/bash
printf 'lark-setup %s\\n' "$*" >> "$COMMAND_LOG"
EOF
  cat > "$bin/dsh-model-setup" <<'EOF'
#!/bin/bash
printf 'model-setup %s\\n' "$*" >> "$COMMAND_LOG"
EOF
  chmod 755 "$bin/dsh-lark-setup" "$bin/dsh-model-setup"
fi
`)

    const result = spawnSync('/bin/bash', [
      localInstaller, '--scenario', 'lark', '--lark', 'keep', '--model-provider', 'traex-agent', '--yes',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        DSH_HOME: dshHome,
        COMMAND_LOG: commandLog,
      },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('traex 未确认登录')
    const log = await readFile(commandLog, 'utf8')
    expect(log).not.toContain('model-setup --dsh-home')
    expect(log).not.toContain('systemctl --user restart dsh-profile-web.service')
    expect(await readFile(join(dshHome, 'settings.yaml'), 'utf8')).toBe(originalSettings)
  })

  test('agent-route rollback restores the exact pre-write settings and profile patch', async () => {
    const dshHome = await temporaryDshHome()
    const profileDirectory = join(dshHome, 'profiles', 'web')
    const settingsPath = join(dshHome, 'settings.yaml')
    const profilePatch = join(profileDirectory, 'cordis.patch.yml')
    const originalSettings = 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n'
    const originalPatch = '# owner overlay\n[]\n'
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(settingsPath, originalSettings, 'utf8')
    await writeFile(profilePatch, originalPatch, 'utf8')

    const result = spawnSync('/bin/bash', [
      '-c', [
        'source "$1"',
        'snapshot="$(dsh_enhanced_snapshot_agent_route_configuration "$2" "$3")" || exit $?',
        "printf 'agent-default-model:\\n  provider: traex-agent\\n' > \"$3/settings.yaml\"",
        "printf '%s\\n' '- id: dsh-enhanced-traex-acp-provider' '  config: { enabled: true }' > \"$3/profiles/$2/cordis.patch.yml\"",
        'dsh_enhanced_restore_agent_route_configuration "$snapshot" "$2" "$3"',
      ].join('\n'),
      'installer-test', installerLibrary, 'web', dshHome,
    ], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(settingsPath, 'utf8')).toBe(originalSettings)
    expect(await readFile(profilePatch, 'utf8')).toBe(originalPatch)
  })

  test('agent-route transaction restores files when SIGTERM lands after the model write', async () => {
    const dshHome = await temporaryDshHome()
    const profileDirectory = join(dshHome, 'profiles', 'web')
    const settingsPath = join(dshHome, 'settings.yaml')
    const profilePatch = join(profileDirectory, 'cordis.patch.yml')
    const originalSettings = 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n'
    const originalPatch = '# owner overlay\n[]\n'
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(settingsPath, originalSettings, 'utf8')
    await writeFile(profilePatch, originalPatch, 'utf8')

    // `$$` is the pid of the subshell that installed the EXIT/TERM traps: inside
    // a `name() ( ... )` subshell function bash keeps `$$` pointing at that
    // shell, so the signal reaches the rollback owner. `$BASHPID` is unset on
    // macOS bash 3.2, and deriving a pid via `exec sh -c 'echo $PPID'` returns
    // the command substitution's own child instead, which exits 143 without ever
    // running the restore.
    //
    // Signalling `$$` is fatal to the shell that runs it, so the transaction runs
    // in a nested shell; the outer shell survives to observe its 143 and to keep
    // the rollback assertions below reachable.
    const result = spawnSync('/bin/bash', [
      '-c', [
        'inner=$(cat <<\'SCRIPT\'',
        'source "$1"',
        'dsh_enhanced_apply_model() {',
        `  printf 'agent-default-model:\\n  provider: traex-agent\\n' > "$2/settings.yaml"`,
        `  printf '%s\\n' '- id: dsh-enhanced-traex-acp-provider' > "$2/profiles/$1/cordis.patch.yml"`,
        '  kill -TERM "$$"',
        '}',
        'dsh_enhanced_verify_model_route() { return 1; }',
        'dsh_enhanced_apply_verified_agent_model "$2" "$3" traex-agent "" "" "" "" 0 1',
        'SCRIPT',
        ')',
        '/bin/bash -c "$inner" installer-test "$1" "$2" "$3"',
        'status=$?',
        '[[ "$status" == 143 ]]',
      ].join('\n'),
      'installer-test', installerLibrary, 'web', dshHome,
    ], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('已恢复原有 settings/profile patch')
    expect(await readFile(settingsPath, 'utf8')).toBe(originalSettings)
    expect(await readFile(profilePatch, 'utf8')).toBe(originalPatch)
  })

  test('auto mode keeps an existing enabled Feishu bot and only restarts its service', async () => {
    const dshHome = await temporaryDshHome()
    await configureExistingLark(dshHome)

    const result = runInstaller(localInstaller, ['--dry-run', '--yes'], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('飞书处理：保留当前应用配置')
    expect(result.stdout).toContain('检测到已有启用的 Lark channel；跳过临时 Host')
    const larkSetup = join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'dsh-lark-setup')
    const installService = `${larkSetup} --profile web --install-service`
    expect(result.stdout).toContain(installService)
    expect(result.stdout).not.toContain('--refresh-agent-policy')
  })

  test('recognizes a home-layer Lark binding as the effective profile binding', async () => {
    const dshHome = await temporaryDshHome()
    await writeFile(join(dshHome, 'cordis.patch.yml'), `- id: dsh-enhanced-lark-channel
  config:
    enabled: true
    appId: cli_0123456789abcdef
`, 'utf8')

    const result = runInstaller(localInstaller, ['--dry-run', '--yes'], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('部署场景：lark')
    expect(result.stdout).toContain('飞书处理：保留当前应用配置')
    expect(result.stdout).toContain('检测到已有启用的 Lark channel；跳过临时 Host')
  })

  test('a profile-layer Lark disable overrides a configured home layer', async () => {
    const dshHome = await temporaryDshHome()
    const profilePatch = join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
    await mkdir(dirname(profilePatch), { recursive: true })
    await writeFile(join(dshHome, 'cordis.patch.yml'), `- id: dsh-enhanced-lark-channel
  config:
    enabled: true
    appId: cli_0123456789abcdef
`, 'utf8')
    await writeFile(profilePatch, `- id: dsh-enhanced-lark-channel
  disabled: true
`, 'utf8')

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_effective_lark_is_configured "$2" "$3"',
      'installer-test', installerLibrary, profilePatch, join(dshHome, 'cordis.patch.yml'),
    ], { encoding: 'utf8' })

    expect(result.status).toBe(1)
  })

  test('fresh configure mode preserves Agent tool reachability unless it is explicitly authorized', async () => {
    const dshHome = await temporaryDshHome()

    // The trailing assertions describe the Linux systemd preflight, so pin the
    // platform rather than depending on the host running this suite.
    const result = runInstaller(localInstaller, ['--dry-run', '--lark', 'configure'], dshHome, 'Linux')

    expect(result.status, result.stderr).toBe(0)
    const larkSetup = join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'dsh-lark-setup')
    const setupCommands = result.stdout
      .split('\n')
      .filter(line => line.includes('dsh-lark-setup'))
    expect(setupCommands).toEqual([
      `  $ ${larkSetup} --profile web`,
    ])
    expect(result.stdout).toContain('将在飞书授权前验证 user manager')
    expect(result.stdout).toContain('常驻服务与 Linux logout persistence')
  })

  test('Linux service preflight enables lingering without sudo before checking the user manager', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const commandLog = join(root, 'commands.log')
    const lingerState = join(root, 'linger-enabled')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'id'), `#!/bin/bash
printf 'id %s\n' "$*" >> "$COMMAND_LOG"
printf '424242\n'
`)
    await writeExecutable(join(fakeBin, 'loginctl'), `#!/bin/bash
printf 'loginctl %s\n' "$*" >> "$COMMAND_LOG"
if [[ "\${1:-}" == 'show-user' ]]; then
  if [[ -f "$LINGER_STATE" ]]; then printf 'yes\n'; else printf 'no\n'; fi
  exit 0
fi
if [[ "\${1:-}" == '--no-ask-password' && "\${2:-}" == 'enable-linger' ]]; then
  touch "$LINGER_STATE"
  exit 0
fi
exit 2
`)
    await writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\n' "$*" >> "$COMMAND_LOG"
exit 0
`)

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_prepare_linux_resident_service 0',
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        COMMAND_LOG: commandLog,
        LINGER_STATE: lingerState,
        DSH_ENHANCED_PLATFORM_OVERRIDE: 'linux',
      },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('已为当前用户启用 logout persistence')
    expect(result.stdout).toContain('user manager 与 logout persistence 已就绪')
    const log = await readFile(commandLog, 'utf8')
    expect(log).toContain(`loginctl show-user ${process.geteuid?.() ?? process.getuid?.()}`)
    expect(log).toContain('loginctl --no-ask-password enable-linger')
    expect(log).toContain('systemctl --user show-environment')
    expect(log).not.toContain('sudo')
    expect(log).not.toContain('id -u')
  })

  test('Linux service preflight stops before OAuth when lingering needs explicit administrator approval', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const commandLog = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'loginctl'), `#!/bin/bash
printf 'loginctl %s\n' "$*" >> "$COMMAND_LOG"
if [[ "\${1:-}" == 'show-user' ]]; then printf 'no\n'; exit 0; fi
exit 1
`)
    await writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\n' "$*" >> "$COMMAND_LOG"
exit 0
`)

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_prepare_linux_resident_service 0',
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        COMMAND_LOG: commandLog,
        DSH_ENHANCED_PLATFORM_OVERRIDE: 'linux',
      },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('sudo loginctl enable-linger "$(id -u)"')
    expect(result.stderr).toContain('尚未开始飞书授权')
    const log = await readFile(commandLog, 'utf8')
    expect(log).not.toContain('systemctl')
  })

  test('interactive Linux preflight explains and runs exactly one fixed sudo action after confirmation', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const commandLog = join(root, 'commands.log')
    const lingerState = join(root, 'linger-enabled')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'loginctl'), `#!/bin/bash
printf 'loginctl %s\n' "$*" >> "$COMMAND_LOG"
if [[ "\${1:-}" == 'show-user' ]]; then
  if [[ -f "$LINGER_STATE" ]]; then printf 'yes\n'; else printf 'no\n'; fi
  exit 0
fi
if [[ "\${1:-}" == '--no-ask-password' ]]; then exit 1; fi
if [[ "\${1:-}" == 'enable-linger' ]]; then touch "$LINGER_STATE"; exit 0; fi
exit 2
`)
    await writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\n' "$*" >> "$COMMAND_LOG"
exit 0
`)
    await writeExecutable(join(fakeBin, 'sudo'), `#!/bin/bash
printf 'sudo %s\n' "$*" >> "$COMMAND_LOG"
if [[ "\${1:-}" == '--' ]]; then shift; fi
"$@"
`)

    const result = spawnSync('/bin/bash', [
      '-c', `source "$1"
dsh_enhanced_trusted_system_command() { printf '%s/%s\\n' "$FAKE_BIN" "$1"; }
dsh_enhanced_prepare_linux_resident_service 0 force`,
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      input: '\n',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        COMMAND_LOG: commandLog,
        LINGER_STATE: lingerState,
        FAKE_BIN: fakeBin,
        DSH_ENHANCED_PLATFORM_OVERRIDE: 'linux',
      },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('唯一的提权动作')
    expect(result.stderr).toContain('现在通过 sudo 启用？[Y/n]')
    expect(result.stdout).toContain('密码由 sudo 直接读取，不会进入安装器')
    const log = await readFile(commandLog, 'utf8')
    expect(log).toContain(`sudo -- ${join(fakeBin, 'loginctl')} enable-linger`)
    expect(log.match(/^sudo /gmu)).toHaveLength(1)
    expect(log).toContain('systemctl --user show-environment')
  })

  test('requires explicit confirmation before planning a danger-full-access default', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--permission', 'danger-full-access',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--confirm-dangerous-full-access')
    expect(result.stdout).not.toContain('dsh plugin')
  })

  test('prints the bounded headless model route check only when requested', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-route', 'verify',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("dsh --profile headless Reply\\ with\\ exactly\\ DSH_ROUTE_READY")
  })

  test('an agent-route default verifies structurally instead of a headless model call', async () => {
    const dshHome = await temporaryDshHome()
    // The runtime resolves the settings.yaml user-layer selection, which is what
    // the verifier reads; a real run would have just written it.
    await writeFile(join(dshHome, 'settings.yaml'),
      'agent-default-model:\n  provider: traex-agent\n  model: default\n', 'utf8')

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-route', 'verify',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('agent route traex-agent 不发送模型请求')
    expect(result.stdout).toContain('校验 profile web 已注册适配器并检查本机登录')
    // No headless model call is planned for an agent route.
    expect(result.stdout).not.toContain('DSH_ROUTE_READY')
  })

  test('the effective-default reader returns the settings.yaml user-layer provider', async () => {
    const dshHome = await temporaryDshHome()
    await writeFile(join(dshHome, 'settings.yaml'),
      'ui-theme:\n  preference: dark\nagent-default-model:\n  provider: traex-agent\n  model: default\nllm-pi-ai:\n  providers: {}\n', 'utf8')

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_effective_default_provider "$2"', 'installer-test', installerLibrary, dshHome,
    ], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('traex-agent')
  })

  test('the effective-default reader also parses a flow-style settings document', async () => {
    // dsh-model-setup writes block style, but a hand-edited or legacy file may be
    // flow style; the reader must still resolve the provider so agent-route
    // verification does not fall back to a headless model call.
    const dshHome = await temporaryDshHome()
    const read = async (document: string): Promise<string> => {
      await writeFile(join(dshHome, 'settings.yaml'), document, 'utf8')
      const result = spawnSync('/bin/bash', [
        '-c', 'source "$1"; dsh_enhanced_effective_default_provider "$2"', 'installer-test', installerLibrary, dshHome,
      ], { encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      return result.stdout.trim()
    }

    expect(await read('{ agent-default-model: { provider: traex-agent, model: default } }\n')).toBe('traex-agent')
    expect(await read('{ ui-theme: { preference: dark }, agent-default-model: { provider: super-relay, model: glm5.2 } }\n')).toBe('super-relay')
    expect(await read('ui-theme:\n  preference: dark\n')).toBe('')
  })

  test('a fresh install then read resolves the agent-route provider end to end', async () => {
    // Regression for the flow-style serialization bug: with no prior settings
    // file, dsh-model-setup must write block-style YAML the installer can parse.
    const dshHome = await temporaryDshHome()
    const setupBin = join(repoRoot, 'plugins', 'personal-assistant', 'bin', 'dsh-model-setup.js')
    const write = spawnSync(process.execPath, [
      setupBin, '--dsh-home', dshHome, '--provider', 'traex-agent', '--enable-in-profile', 'web',
    ], { encoding: 'utf8', env: { ...process.env, DSH_HOME: dshHome } })
    expect(write.status, write.stderr).toBe(0)

    const read = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_effective_default_provider "$2"', 'installer-test', installerLibrary, dshHome,
    ], { encoding: 'utf8' })
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout.trim()).toBe('traex-agent')
  })

  test('non-interactive default keeps the composed model without configuring a route', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, ['--dry-run', '--lark', 'skip'], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('模型配置：本次跳过；使用 profile 已组合的默认模型。')
    expect(result.stdout).not.toContain('dsh-model-setup')
  })

  test('resolves dsh-model-setup from the pnpm shim, then falls back to a node-run package bin', async () => {
    const dshHome = await temporaryDshHome()
    const base = join(dshHome, 'profiles', 'web', 'node_modules')
    const binDir = join(base, '.bin')
    const paScript = join(base, '@dsh-enhanced', 'personal-assistant', 'bin', 'dsh-model-setup.js')
    const apScript = join(base, '@dsh-enhanced', 'assistant-policy', 'bin', 'dsh-model-setup.js')

    const resolve = (): { status: number | null; stdout: string } => spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_resolve_model_setup web "$2"', 'installer-test', installerLibrary, dshHome,
    ], { encoding: 'utf8' })

    // No launcher anywhere -> non-zero, no output.
    const none = resolve()
    expect(none.status).not.toBe(0)
    expect(none.stdout).toBe('')

    // Package bin present but no shim -> node fallback (prefers personal-assistant).
    await mkdir(join(base, '@dsh-enhanced', 'assistant-policy', 'bin'), { recursive: true })
    await writeFile(apScript, '// stub\n', 'utf8')
    const apOnly = resolve()
    expect(apOnly.status, apOnly.stdout).toBe(0)
    expect(apOnly.stdout).toBe(`node\n${apScript}\n`)

    await mkdir(join(base, '@dsh-enhanced', 'personal-assistant', 'bin'), { recursive: true })
    await writeFile(paScript, '// stub\n', 'utf8')
    const preferPa = resolve()
    expect(preferPa.stdout).toBe(`node\n${paScript}\n`)

    // An executable shim wins over the package bins.
    await mkdir(binDir, { recursive: true })
    await writeExecutable(join(binDir, 'dsh-model-setup'), '#!/bin/bash\nexit 0\n')
    const withShim = resolve()
    expect(withShim.stdout).toBe(`${join(binDir, 'dsh-model-setup')}\n`)
  })

  test('configuring deepseek-official plans an env-only key store into settings and credentials', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'deepseek-official', '--model-name', 'deepseek-v4-flash',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('模型配置：provider=deepseek-official model=deepseek-v4-flash')
    expect(result.stdout).toContain(
      `${join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'dsh-model-setup')} `
      + `--dsh-home ${dshHome} --provider deepseek-official --model deepseek-v4-flash`,
    )
    // The key is never an argument; without one in the environment the plan
    // still writes the route and names the credential reference to set later.
    expect(result.stdout).toContain('未检测到 API Key，稍后请设置 DEEPSEEK_API_KEY')
    expect(result.stdout).not.toContain('--store-key')
  })

  test('an available key env var upgrades the deepseek plan to store the credential', async () => {
    const dshHome = await temporaryDshHome()

    const result = spawnSync('/bin/bash', [localInstaller,
      '--dry-run', '--lark', 'skip', '--model-provider', 'deepseek-official',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', DSH_HOME: dshHome, DSH_ENHANCED_MODEL_API_KEY: 'plat-secret' },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('把环境中的 API Key 存入 .credentials.yaml')
    expect(result.stdout).toContain('--provider deepseek-official --store-key')
  })

  test('a custom gateway route plans llm-pi-ai transport fields', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'super-relay', '--model-name', 'glm5.2',
      '--model-base-url', 'https://super-relay.example/v1', '--model-api', 'openai-completions',
      '--model-display-name', 'Super Relay',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      '--provider super-relay --model glm5.2 --base-url https://super-relay.example/v1'
      + ' --api openai-completions --display-name Super\\ Relay',
    )
  })

  test('rejects a custom gateway route without a base URL and deepseek with transport fields', async () => {
    const dshHome = await temporaryDshHome()

    const missingBaseUrl = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'super-relay', '--model-name', 'glm5.2',
    ], dshHome)
    expect(missingBaseUrl.status).toBe(2)
    expect(missingBaseUrl.stderr).toContain('自定义模型 provider 需要 --model-base-url')
    expect(missingBaseUrl.stdout).not.toContain('dsh plugin')

    const misplacedFields = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'deepseek-official', '--model-base-url', 'https://x/v1',
    ], dshHome)
    expect(misplacedFields.status).toBe(2)
    expect(misplacedFields.stderr).toContain('仅适用于自定义 provider')
    expect(misplacedFields.stdout).not.toContain('dsh plugin')
  })

  test('non-interactive configure without a provider guides the owner to the model flags', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model', 'configure',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('非交互配置模型需要 --model-provider')
  })

  test('restarts the resident service after (re)configuring the model on a managed profile', async () => {
    const dshHome = await temporaryDshHome()
    await configureExistingLark(dshHome)

    // Keeping the existing Feishu bot leaves a managed resident service, so a
    // model (re)configuration must restart it to load the new default/route.
    // The restart is delegated to the platform's own supervisor, so pin the
    // detected platform and assert both real branches.
    const linux = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'keep', '--model-provider', 'deepseek-official', '--model-name', 'deepseek-v4-flash',
    ], dshHome, 'Linux')

    expect(linux.status, linux.stderr).toBe(0)
    expect(linux.stdout).toContain('常驻服务：将重启以加载新模型配置。')
    expect(linux.stdout).toContain('systemctl --user restart dsh-profile-web.service')

    const darwin = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'keep', '--model-provider', 'deepseek-official', '--model-name', 'deepseek-v4-flash',
    ], dshHome, 'Darwin')

    expect(darwin.status, darwin.stderr).toBe(0)
    expect(darwin.stdout).toContain('常驻服务：将重启以加载新模型配置。')
    expect(darwin.stdout).toContain('launchctl kickstart -k')
  })

  test('does not restart a service when the model step is skipped or no service is managed', async () => {
    const skipHome = await temporaryDshHome()
    const skipModel = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model', 'skip',
    ], skipHome)
    expect(skipModel.status, skipModel.stderr).toBe(0)
    expect(skipModel.stdout).not.toContain('常驻服务：将重启以加载新模型配置。')

    // core scenario configures a model but manages no channel/service.
    const coreHome = await temporaryDshHome()
    const core = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'deepseek-official',
    ], coreHome)
    expect(core.status, core.stderr).toBe(0)
    expect(core.stdout).not.toContain('常驻服务：将重启以加载新模型配置。')
  })

  test('model menu writes UI separately from its machine-readable selection', () => {
    const configured = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_choose_model_mode 1', 'installer-test', installerLibrary,
    ], { encoding: 'utf8', input: '2\n' })
    expect(configured.status, configured.stderr).toBe(0)
    expect(configured.stdout).toBe('configure')
    expect(configured.stderr).toContain('检测到当前 profile 已能解析默认模型')

    const unconfigured = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_choose_model_mode 0', 'installer-test', installerLibrary,
    ], { encoding: 'utf8', input: '\n' })
    expect(unconfigured.status, unconfigured.stderr).toBe(0)
    expect(unconfigured.stdout).toBe('configure')
    expect(unconfigured.stderr).toContain('尚未配置可用的默认模型')
  })

  test('selecting the local TraeX route plans bundle install, default selection, and profile enable', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'traex-agent',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    // The provider bundle is pulled into the top-level install set...
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'traex-acp-provider'))
    // ...and the default-model write enables the route in this profile's patch.
    expect(result.stdout).toContain('模型配置：provider=traex-agent')
    expect(result.stdout).toContain(
      `${join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'dsh-model-setup')} `
      + `--dsh-home ${dshHome} --provider traex-agent --enable-in-profile web`,
    )
    // Agent routes never touch an API key.
    expect(result.stdout).not.toContain('--store-key')
    expect(result.stdout).not.toContain('存入 .credentials.yaml')
    expect(result.stdout).toContain('无需 API Key')
    expect(result.stdout).toContain('本轮已配置 TraeX，正在执行免额度的适配器与登录校验')
    expect(result.stdout).toContain('agent route traex-agent 不发送模型请求')
    expect(result.stdout).not.toContain('DSH_ROUTE_READY')
  })

  test('rejects gateway transport fields on the TraeX agent route', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'traex-agent', '--model-base-url', 'https://x/v1',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('不适用于本机 agent route traex-agent')
    expect(result.stdout).not.toContain('dsh plugin')
  })

  test('the model prompt offers TraeX only when a local traex command is present', () => {
    const scriptWithTraex = 'export PATH="$2:$PATH"; source "$1"; '
      + 'dsh_enhanced_prompt_model_route p m b a d >/dev/null; printf "provider=%s" "$p"'
    const fakeBin = join(tmpdir(), `dsh-fake-traex-${Date.now()}`)

    return (async () => {
      await mkdir(fakeBin, { recursive: true })
      await writeExecutable(join(fakeBin, 'traex'), '#!/bin/bash\nexit 0\n')

      const withTraex = spawnSync('/bin/bash', ['-c', scriptWithTraex, 'installer-test', installerLibrary, fakeBin], {
        encoding: 'utf8', input: '3\n',
      })
      expect(withTraex.status, withTraex.stderr).toBe(0)
      expect(withTraex.stderr).toContain('本机 TraeX')
      expect(withTraex.stdout).toBe('provider=traex-agent')

      // Without a traex command on PATH, option 3 is not offered and is invalid.
      const withoutTraex = spawnSync('/bin/bash', [
        '-c', 'export PATH="/nonexistent-only"; source "$1"; dsh_enhanced_prompt_model_route p m b a d; printf "rc=%s" "$?"',
        'installer-test', installerLibrary,
      ], { encoding: 'utf8', input: '3\n' })
      expect(withoutTraex.stderr).not.toContain('本机 TraeX')

      await rm(fakeBin, { recursive: true, force: true })
    })()
  })

  test('explicit configure mode reruns onboarding and can avoid installing a service', async () => {
    const dshHome = await temporaryDshHome()
    await configureExistingLark(dshHome)

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'configure', '--no-service',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('飞书处理：选择已有应用或创建新应用，并覆盖当前 channel 配置')
    expect(result.stdout).toContain('dsh-lark-setup --profile web --no-service')
  })

  test('Feishu menu writes UI separately from its machine-readable selection', () => {
    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_choose_lark_mode 1', 'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      input: '2\n',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('configure')
    expect(result.stderr).toContain('检测到当前 profile 已启用飞书 Bot')
  })

  test('rejects unsafe profile names before planning any installation', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--profile', '../web',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('profile 名称不合法')
    expect(result.stdout).not.toContain('dsh plugin')
  })

  test('restart command rebuilds and kickstarts web without installation or onboarding', async () => {
    const dshHome = await temporaryDshHome()

    const result = runRestart([], dshHome, 'darwin')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('pnpm build')
    expect(result.stdout).toContain('launchctl kickstart -k gui/')
    expect(result.stdout).toContain('/ai.deepseek.dsh.profile.web')
    expect(result.stdout).not.toContain('dsh plugin')
    expect(result.stdout).not.toContain('dsh-lark-setup')
  })

  test('restart command accepts the profile as its only optional argument', async () => {
    const dshHome = await temporaryDshHome()

    const result = runRestart(['personal-web'], dshHome, 'darwin')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('pnpm build')
    expect(result.stdout).toContain('/ai.deepseek.dsh.profile.personal-web')
  })

  test('restart command rejects more than one argument', async () => {
    const dshHome = await temporaryDshHome()

    const result = runRestart(['web', 'extra'], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('只接受一个可选的 profile 参数')
  })

  test('restart command uses systemd on Linux and Task Scheduler on Windows', async () => {
    const dshHome = await temporaryDshHome()

    const linux = runRestart(['web'], dshHome, 'linux')
    expect(linux.status, linux.stderr).toBe(0)
    expect(linux.stdout).toContain('systemctl --user restart dsh-profile-web.service')

    const windows = runRestart(['web'], dshHome, 'windows')
    expect(windows.status, windows.stderr).toBe(0)
    expect(windows.stdout).toContain('schtasks.exe /End /TN DSH\\ profile\\ web')
    expect(windows.stdout).toContain('schtasks.exe /Run /TN DSH\\ profile\\ web')
  })
})
