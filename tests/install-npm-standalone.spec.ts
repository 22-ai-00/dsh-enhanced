import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installDirectory = join(repoRoot, 'scripts', 'install')
const yamlPackageRoot = dirname(createRequire(import.meta.url).resolve('yaml/package.json'))

const ASSET_NAMES = [
  'common.sh',
  'lifecycle-config.mjs',
  'lifecycle-profile.mjs',
  'host-lifecycle.mjs',
  'host-profile-update.mjs',
  'host-rsi-update.mjs',
] as const

type AssetName = (typeof ASSET_NAMES)[number]

const cleanupDirectories: string[] = []
const activeServers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map(close => close()))
  await Promise.all(cleanupDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function trackTempDir(parent: string, prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(parent, prefix)))
  cleanupDirectories.push(dir)
  return dir
}

function outsideTmpParent(): string {
  const value = tmpdir()
  return value !== '/tmp' && !value.startsWith('/tmp/') ? value : '/var/tmp'
}

async function startAssetServer() {
  const assets = new Map<AssetName, { bytes: Buffer; sha256: string }>()
  await Promise.all(ASSET_NAMES.map(async name => {
    const bytes = await readFile(join(installDirectory, name))
    assets.set(name, { bytes, sha256: sha256(bytes) })
  }))
  const requested: string[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    requested.push(pathname)
    const assetName = pathname.split('/').pop() as AssetName | undefined
    const asset = assetName !== undefined ? assets.get(assetName) : undefined
    if (asset === undefined) {
      response.writeHead(404)
      response.end('not found')
      return
    }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(asset.bytes)
  })
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('failed to bind local asset HTTP server')
  const close = () => new Promise<void>((resolveClose, rejectClose) => {
    server.close(error => (error ? rejectClose(error) : resolveClose()))
  })
  activeServers.push(close)
  const hashEnv = {
    DSH_RAY_INSTALL_COMMON_SHA256: assets.get('common.sh')!.sha256,
    DSH_RAY_INSTALL_LIFECYCLE_CONFIG_SHA256: assets.get('lifecycle-config.mjs')!.sha256,
    DSH_RAY_INSTALL_LIFECYCLE_PROFILE_SHA256: assets.get('lifecycle-profile.mjs')!.sha256,
    DSH_RAY_INSTALL_HOST_LIFECYCLE_SHA256: assets.get('host-lifecycle.mjs')!.sha256,
    DSH_RAY_INSTALL_HOST_PROFILE_UPDATE_SHA256: assets.get('host-profile-update.mjs')!.sha256,
    DSH_RAY_INSTALL_HOST_RSI_UPDATE_SHA256: assets.get('host-rsi-update.mjs')!.sha256,
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v9.8.7`,
    hashEnv,
    requested,
  }
}

async function createStandaloneInstallerCopy(): Promise<string> {
  // Place only install-npm.sh in an empty directory outside the repo so
  // SCRIPT_DIRECTORY/common.sh is absent and the remote download path runs.
  const dir = await trackTempDir(tmpdir(), 'dsh-standalone-script-')
  const scriptPath = join(dir, 'install-npm.sh')
  await copyFile(join(installDirectory, 'install-npm.sh'), scriptPath)
  await chmod(scriptPath, 0o755)
  return scriptPath
}

async function createFakeDshHost(root: string, binDir: string): Promise<string> {
  const hostRoot = join(root, 'fake-host')
  const dshDir = join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh')
  const managerDir = join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh-plugin-manager')
  await Promise.all([
    mkdir(join(dshDir, 'lib'), { recursive: true }),
    mkdir(join(managerDir, 'node_modules'), { recursive: true }),
  ])
  await writeFile(join(dshDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: '0.2.2-rc.5',
    type: 'module',
    bin: { dsh: 'lib/bin.js' },
    dependencies: { '@deepseek-ai/dsh-plugin-manager': '0.2.2-rc.5' },
  }), 'utf8')
  await writeFile(join(managerDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-plugin-manager',
    version: '0.2.2-rc.5',
    dependencies: { yaml: '^2.9.0' },
  }), 'utf8')
  await cp(yamlPackageRoot, join(managerDir, 'node_modules', 'yaml'), { recursive: true })
  const dshLog = join(root, 'dsh.log')
  await writeFile(dshLog, '', 'utf8')
  const binScript = join(dshDir, 'lib', 'bin.js')
  await writeFile(binScript, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const logPath = process.env.STANDALONE_DSH_LOG
if (logPath) {
  appendFileSync(logPath, JSON.stringify({ args, ci: process.env.CI ?? null }) + '\\n')
}
if (args[0] === '--version') {
  process.stdout.write('0.2.2-rc.5\\n')
  process.exit(0)
}
if (args.includes('--dump-config')) {
  const home = process.env.DSH_HOME
  const custom = home ? (() => { try { return readFileSync(join(home, '.dump-config.yml'), 'utf8') } catch { return null } })() : null
  process.stdout.write(custom ?? "- id: dsh-ray-assistant-web-owner\\n  name: '@dsh-ray/assistant-web-owner'\\n")
  process.exit(0)
}
if (args.includes('--port')) {
  process.stdout.write('dsh web: http://127.0.0.1:43210\\n')
  process.exit(0)
}
if (args.includes('plugin') && args.includes('add')) {
  process.exit(0)
}
process.exit(0)
`, 'utf8')
  await chmod(binScript, 0o755)
  await symlink(binScript, join(binDir, 'dsh'))
  return dshLog
}

async function createFakeNpmAndPnpm(root: string, binDir: string): Promise<{ npmLog: string; pnpmLog: string; storeDir: string }> {
  const npmLog = join(root, 'npm.log')
  const pnpmLog = join(root, 'pnpm.log')
  const storeDir = join(root, 'pnpm-store')
  await mkdir(storeDir, { mode: 0o700, recursive: true })
  await writeFile(npmLog, '', 'utf8')
  await writeFile(pnpmLog, '', 'utf8')

  await writeFile(join(binDir, 'npm'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(npmLog)}, JSON.stringify(args) + '\\n')
if (args[0] === 'view' && args.includes('version')) {
  process.stdout.write(JSON.stringify('0.2.2') + '\\n')
  process.exit(0)
}
process.exit(0)
`, 'utf8')
  await chmod(join(binDir, 'npm'), 0o755)

  await writeFile(join(binDir, 'pnpm'), `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
try {
  appendFileSync(${JSON.stringify(pnpmLog)}, JSON.stringify({ args, ci: process.env.CI ?? null, cwd: process.cwd() }) + '\\n')
} catch (error) {
  if (error?.code !== 'EROFS') throw error
}
let dir = process.cwd()
const filtered = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dir' && i + 1 < args.length) { dir = args[++i]; continue }
  filtered.push(args[i])
}
if (filtered[0] === 'store' && filtered[1] === 'path') {
  process.stdout.write(${JSON.stringify(storeDir)} + '\\n')
  process.exit(0)
}
if (filtered[0] === 'config' && filtered[1] === 'list' && filtered.includes('--json')) {
  process.stdout.write(JSON.stringify({ registry: 'https://registry.npmjs.org/' }) + '\\n')
  process.exit(0)
}
if (filtered[0] === 'add' && filtered.includes('--lockfile-only')) {
  const pkgPath = join(dir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.dependencies = pkg.dependencies ?? {}
  for (const spec of filtered.slice(1)) {
    if (spec.startsWith('-')) continue
    const match = /^(@dsh-ray\\/[a-z0-9-]+)@(.+)$/u.exec(spec)
    if (match) pkg.dependencies[match[1]] = match[2]
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\\n')
  const lock = [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '  .:',
    '    dependencies:',
    ...Object.entries(pkg.dependencies).flatMap(([name, ver]) => [
      \`      '\${name}':\`,
      \`        specifier: \${ver}\`,
      \`        version: \${ver}\`,
    ]),
    '',
    'packages:',
    ...Object.entries(pkg.dependencies).map(([name, ver]) =>
      \`  '\${name}@\${ver}': {resolution: {integrity: sha512-test}}\`,
    ),
    '',
    'snapshots:',
    ...Object.entries(pkg.dependencies).map(([name, ver]) =>
      \`  '\${name}@\${ver}': {}\`,
    ),
    '',
  ].join('\\n')
  writeFileSync(join(dir, 'pnpm-lock.yaml'), lock)
  process.exit(0)
}
if (filtered[0] === 'install' && filtered.includes('--lockfile-only') && filtered.includes('--frozen-lockfile')) {
  process.exit(0)
}
if (filtered[0] === 'fetch' && filtered.includes('--frozen-lockfile')) {
  const cacheDir = process.env.pnpm_config_cache_dir
  if (!cacheDir) process.exit(91)
  writeFileSync(join(cacheDir, 'lockfile-verified.jsonl'), JSON.stringify({
    lockfile: { path: join(dir, 'pnpm-lock.yaml'), hash: 'verified' },
    policy: { tarballUrlBinding: true, resolutionShapeCheck: true, dependencyAliasCheck: true },
  }) + '\\n')
  process.exit(0)
}
if (filtered[0] === 'install' && filtered.includes('--offline') && filtered.includes('--frozen-lockfile')) {
  if (process.env.CI !== 'true') {
    process.stderr.write('ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY\\n')
    process.exit(1)
  }
  mkdirSync(join(dir, 'node_modules', '.pnpm'), { mode: 0o700, recursive: true })
  writeFileSync(join(dir, 'node_modules', '.ci-observed'), String(process.env.CI), { mode: 0o600 })
  process.exit(0)
}
process.exit(0)
`, 'utf8')
  await chmod(join(binDir, 'pnpm'), 0o755)
  return { npmLog, pnpmLog, storeDir }
}

async function invokeStandalone(
  scriptPath: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
  cwd = dirname(scriptPath),
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  // Omit TMPDIR when testing Linux standalone remote download so install-npm.sh
  // picks root-owned /tmp for its TEMPORARY_DIRECTORY ancestor trust check.
  // Use async spawn so the in-process local asset HTTP server stays responsive.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }
  if (!('TMPDIR' in env)) {
    delete childEnv.TMPDIR
  }
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('/bin/bash', [scriptPath, ...args], {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectRun(new Error(`standalone installer timed out; stderr=${stderr}`))
    }, 20_000)
    child.once('error', error => { clearTimeout(timer); rejectRun(error) })
    child.once('close', status => { clearTimeout(timer); resolveRun({ status, stdout, stderr }) })
  })
}

describe('standalone install-npm.sh remote asset closure & non-TTY pnpm', () => {
  test.skipIf(process.platform !== 'linux')('standalone --operation install --dry-run downloads only common.sh over HTTP', async () => {
    const server = await startAssetServer()
    const scriptPath = await createStandaloneInstallerCopy()
    const workspace = await trackTempDir(tmpdir(), 'dsh-standalone-install-')
    const dshHome = join(workspace, 'dsh-home')
    const binDir = join(workspace, 'bin')
    await Promise.all([mkdir(dshHome, { mode: 0o700 }), mkdir(binDir, { mode: 0o755 })])

    const result = await invokeStandalone(scriptPath, ['--dry-run', '--yes', '--lark', 'skip'], {
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: workspace,
      DSH_HOME: dshHome,
      DSH_RAY_INSTALL_REF: 'v9.8.7',
      DSH_RAY_INSTALL_BASE_URL: server.baseUrl,
      DSH_RAY_INSTALL_COMMON_SHA256: server.hashEnv.DSH_RAY_INSTALL_COMMON_SHA256,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(server.requested).toEqual(['/v9.8.7/common.sh'])
  })

  test.skipIf(process.platform !== 'linux')('standalone --operation upgrade downloads all 5 .mjs helpers without DSH_RAY_HOST_UPDATE_PLAN, resolves ESM imports, and passes CI=true to pnpm', async () => {
    const server = await startAssetServer()
    const scriptPath = await createStandaloneInstallerCopy()
    const workspace = await trackTempDir(tmpdir(), 'dsh-standalone-upgrade-')
    const runtimeRoot = await trackTempDir(outsideTmpParent(), 'dsh-standalone-runtime-')
    const dshHome = join(workspace, 'dsh-home')
    const profileDir = join(dshHome, 'profiles', 'web')
    const binDir = join(runtimeRoot, 'bin')
    await Promise.all([
      mkdir(profileDir, { mode: 0o700, recursive: true }),
      mkdir(binDir, { mode: 0o755, recursive: true }),
    ])
    await chmod(dshHome, 0o700)
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { '@dsh-ray/personal-assistant': '0.2.1' },
      dsh: { profile: { bundles: ['@dsh-ray/personal-assistant'] } },
    }, null, 2) + '\n', { mode: 0o600 })
    await writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n', { mode: 0o600 })
    await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n', { mode: 0o600 })
    const dshLog = await createFakeDshHost(runtimeRoot, binDir)
    const { pnpmLog } = await createFakeNpmAndPnpm(runtimeRoot, binDir)

    const result = await invokeStandalone(scriptPath, [
      '--operation', 'upgrade', '--confirm-dsh-home-stopped', '--scenario', 'web', '--plugin-version', '0.2.2',
    ], {
      PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: workspace,
      DSH_HOME: dshHome,
      CI: undefined,
      STANDALONE_DSH_LOG: dshLog,
      DSH_RAY_INSTALL_REF: 'v9.8.7',
      DSH_RAY_INSTALL_BASE_URL: server.baseUrl,
      ...server.hashEnv,
    })

    expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND')
    expect(result.status, result.stderr).toBe(0)
    expect(server.requested).toEqual(ASSET_NAMES.map(name => `/v9.8.7/${name}`))
    const upgradedManifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    expect(upgradedManifest.dependencies['@dsh-ray/personal-assistant']).toBe('0.2.2')
    expect(await readFile(join(profileDir, 'node_modules', '.ci-observed'), 'utf8')).toBe('true')
    const pnpmCalls = (await readFile(pnpmLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(pnpmCalls.every((call: { ci: string | null }) => call.ci === 'true')).toBe(true)
  }, 30_000)

  test.skipIf(process.platform !== 'linux')('standalone --operation upgrade succeeds through bwrap when caller cwd is under /tmp and DSH_HOME is outside /tmp', async () => {
    const server = await startAssetServer()
    const scriptPath = await createStandaloneInstallerCopy()
    const callerTmpCwd = await trackTempDir('/tmp', 'dsh-bwrap-tmp-cwd-')
    const workspace = await trackTempDir(outsideTmpParent(), 'dsh-outside-tmp-upgrade-')
    const dshHome = join(workspace, 'dsh-home')
    const profileDir = join(dshHome, 'profiles', 'web')
    const binDir = join(workspace, 'bin')
    await Promise.all([
      mkdir(profileDir, { mode: 0o700, recursive: true }),
      mkdir(binDir, { mode: 0o755, recursive: true }),
    ])
    await chmod(dshHome, 0o700)
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { '@dsh-ray/personal-assistant': '0.2.1' },
      dsh: { profile: { bundles: ['@dsh-ray/personal-assistant'] } },
    }, null, 2) + '\n', { mode: 0o600 })
    await writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n', { mode: 0o600 })
    await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n', { mode: 0o600 })
    const dshLog = await createFakeDshHost(workspace, binDir)
    await createFakeNpmAndPnpm(workspace, binDir)

    const result = await invokeStandalone(scriptPath, [
      '--operation', 'upgrade', '--confirm-dsh-home-stopped', '--scenario', 'web', '--plugin-version', '0.2.2',
    ], {
      PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: workspace,
      DSH_HOME: dshHome,
      STANDALONE_DSH_LOG: dshLog,
      DSH_RAY_INSTALL_REF: 'v9.8.7',
      DSH_RAY_INSTALL_BASE_URL: server.baseUrl,
      ...server.hashEnv,
    }, callerTmpCwd)

    expect(result.stderr).not.toContain('Can\'t chdir to')
    expect(result.status, result.stderr).toBe(0)
    const upgradedManifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    expect(upgradedManifest.dependencies['@dsh-ray/personal-assistant']).toBe('0.2.2')
  }, 30_000)

  test.skipIf(process.platform !== 'linux')('standalone --operation uninstall downloads all 5 .mjs helpers and runs lifecycle-profile.mjs without ERR_MODULE_NOT_FOUND', async () => {
    const server = await startAssetServer()
    const scriptPath = await createStandaloneInstallerCopy()
    const workspace = await trackTempDir(tmpdir(), 'dsh-standalone-uninstall-')
    const dshHome = join(workspace, 'dsh-home')
    const profileDir = join(dshHome, 'profiles', 'web')
    const binDir = join(workspace, 'bin')
    await Promise.all([
      mkdir(profileDir, { mode: 0o700, recursive: true }),
      mkdir(binDir, { mode: 0o755, recursive: true }),
    ])
    await chmod(dshHome, 0o700)
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }, null, 2) + '\n', { mode: 0o600 })
    await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n', { mode: 0o600 })
    const dshLog = await createFakeDshHost(workspace, binDir)
    await createFakeNpmAndPnpm(workspace, binDir)

    const result = await invokeStandalone(scriptPath, [
      '--operation', 'uninstall', '--confirm-dsh-home-stopped', '--scenario', 'web',
    ], {
      PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: workspace,
      DSH_HOME: dshHome,
      STANDALONE_DSH_LOG: dshLog,
      DSH_RAY_INSTALL_REF: 'v9.8.7',
      DSH_RAY_INSTALL_BASE_URL: server.baseUrl,
      ...server.hashEnv,
    })

    expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('uninstall 已完成')
    expect(server.requested).toEqual(ASSET_NAMES.map(name => `/v9.8.7/${name}`))
  }, 30_000)

  test.skipIf(process.platform !== 'linux')('standalone host recovery downloads all 5 .mjs helpers and runs host-recover cleanly', async () => {
    const server = await startAssetServer()
    const scriptPath = await createStandaloneInstallerCopy()
    const workspace = await trackTempDir(tmpdir(), 'dsh-standalone-host-recover-')
    const dshHome = join(workspace, 'dsh-home')
    const binDir = join(workspace, 'bin')
    await Promise.all([
      mkdir(join(dshHome, 'profiles', 'web'), { mode: 0o700, recursive: true }),
      mkdir(binDir, { mode: 0o755, recursive: true }),
    ])
    await chmod(dshHome, 0o700)
    await createFakeDshHost(workspace, binDir)

    const result = await invokeStandalone(scriptPath, [
      '--operation', 'upgrade', '--confirm-dsh-home-stopped', '--profile', 'web',
    ], {
      PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: workspace,
      DSH_HOME: dshHome,
      DSH_RAY_HOST_RECOVERY_ONLY: '1',
      DSH_RAY_INSTALL_REF: 'v9.8.7',
      DSH_RAY_INSTALL_BASE_URL: server.baseUrl,
      ...server.hashEnv,
    })

    expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND')
    expect(result.status, result.stderr).toBe(0)
    expect(server.requested).toEqual(ASSET_NAMES.map(name => `/v9.8.7/${name}`))
  }, 30_000)

  test('sealed 0400/0500 helper set resolves static and dynamic .mjs imports in isolation without repo tree', async () => {
    const sealedDir = await trackTempDir(tmpdir(), 'dsh-sealed-helpers-')
    for (const name of ['lifecycle-config.mjs', 'lifecycle-profile.mjs', 'host-lifecycle.mjs', 'host-profile-update.mjs', 'host-rsi-update.mjs']) {
      const dest = join(sealedDir, name)
      await copyFile(join(installDirectory, name), dest)
      await chmod(dest, 0o400)
    }
    await chmod(sealedDir, 0o500)
    try {
      const check = spawnSync(process.execPath, [
        '--input-type=module',
        '-e',
        `const dir = process.argv[1];
         await import(${JSON.stringify(pathToFileURL(join(sealedDir, 'lifecycle-profile.mjs')).href)});
         await import(${JSON.stringify(pathToFileURL(join(sealedDir, 'host-profile-update.mjs')).href)});
         await import(${JSON.stringify(pathToFileURL(join(sealedDir, 'host-rsi-update.mjs')).href)});`,
        sealedDir,
      ], { encoding: 'utf8' })
      expect(check.status, check.stderr).toBe(0)
      const unexpectedStderr = check.stderr
        .replace(/^\(node:\d+\) ExperimentalWarning: SQLite[^\n]*\n(?:\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n)?/gmu, '')
        .trim()
      expect(unexpectedStderr).toBe('')
    } finally {
      await chmod(sealedDir, 0o700)
    }
  })

  test('real pnpm@11.7.0 non-TTY purge fails without CI=true and succeeds via host-profile-update.mjs & lifecycle-profile.mjs CI=true handling', async () => {
    const dir = await trackTempDir(tmpdir(), 'dsh-real-pnpm-nontty-')
    const storeDir = join(dir, 'store')
    const cfgDir = join(dir, 'cfg')
    await mkdir(join(dir, 'node_modules', 'stale-pkg'), { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'probe', private: true }), 'utf8')
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\n', 'utf8')
    await writeFile(join(dir, 'node_modules', '.modules.yaml'), 'hoistPattern:\n  - "*"\nlayoutVersion: 5\nnodeLinker: isolated\npackageManager: pnpm@11.7.0\n', 'utf8')

    const cleanEnv = { ...process.env, HOME: dir, XDG_CONFIG_HOME: cfgDir, npm_config_store_dir: storeDir }
    delete cleanEnv.CI
    delete cleanEnv.CONTINUOUS_INTEGRATION
    delete cleanEnv.GITHUB_ACTIONS
    delete cleanEnv.BUILD_NUMBER
    delete cleanEnv.RUN_ID
    const withoutCi = spawnSync('pnpm', ['install', '--offline'], {
      cwd: dir,
      env: cleanEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(withoutCi.status).not.toBe(0)
    expect(`${withoutCi.stdout}\n${withoutCi.stderr}`).toContain('ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY')

    const hostProfileMod = await import(pathToFileURL(join(installDirectory, 'host-profile-update.mjs')).href) as {
      pnpmEnvironment: (root: string, more?: Record<string, string>) => Record<string, string>
      defaultRunPnpm: (args: string[], options: { cwd: string; env: Record<string, string>; phase: string }) => Promise<void>
    }
    const priorCi = process.env.CI
    delete process.env.CI
    try {
      const env = hostProfileMod.pnpmEnvironment(join(dir, 'prep'))
      expect(env.CI).toBe('true')
      await expect(hostProfileMod.defaultRunPnpm(['install', '--offline'], {
        cwd: dir,
        env: { ...env, pnpm_config_store_dir: storeDir },
        phase: 'probe',
      })).resolves.toBeUndefined()
    } finally {
      if (priorCi !== undefined) process.env.CI = priorCi
    }

    // Confirm CI=true does not alter pnpm config list --json compared by assertSameNpmConfig.
    const cfgBefore = spawnSync('pnpm', ['config', 'list', '--json'], { cwd: dir, env: cleanEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const cfgWithCi = spawnSync('pnpm', ['config', 'list', '--json'], { cwd: dir, env: { ...cleanEnv, CI: 'true' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    expect(cfgBefore.status).toBe(0)
    expect(cfgWithCi.status).toBe(0)
    expect(cfgWithCi.stdout).toBe(cfgBefore.stdout)

    // Verify common.sh forwards CI=true to `dsh plugin add` under non-TTY execution.
    const binDir = join(dir, 'bin')
    const homeDir = join(dir, 'home')
    await Promise.all([mkdir(binDir), mkdir(join(homeDir, 'profiles', 'web'), { recursive: true })])
    await writeFile(join(homeDir, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dependencies: {} }), 'utf8')
    await writeFile(join(homeDir, 'profiles', 'web', 'pnpm-workspace.yaml'), 'packages:\n  - .\nallowBuilds:\n  koffi: true\n  protobufjs: false\n', 'utf8')
    await writeFile(join(homeDir, 'profiles', 'web', 'cordis.patch.yml'), '[]\n', 'utf8')
    const dshLog = await createFakeDshHost(dir, binDir)
    await writeFile(join(binDir, 'pnpm'), '#!/usr/bin/env bash\nif [[ "${1:-}" == "--version" ]]; then printf "11.7.0\\n"; exit 0; fi\nexit 0\n', 'utf8')
    await chmod(join(binDir, 'pnpm'), 0o755)
    const commonEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: dir,
      DSH_HOME: homeDir,
      STANDALONE_DSH_LOG: dshLog,
    }
    delete commonEnv.CI
    const macUpgrade = spawnSync('/bin/bash', [
      '-c',
      `set -euo pipefail; source ${JSON.stringify(join(installDirectory, 'common.sh'))}; dsh_ray_macos_upgrade_guard() { return 0; }; dsh_ray_macos_stopped_upgrade web ${JSON.stringify(homeDir)} 0 npm @dsh-ray/personal-assistant@0.2.2; dsh_ray_ensure_agent_bundle traex-agent web ${JSON.stringify(homeDir)} npm ${JSON.stringify(repoRoot)} 0.2.2 0`,
    ], {
      cwd: dir,
      env: commonEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(macUpgrade.status, macUpgrade.stderr).toBe(0)
    const dshCalls = (await readFile(dshLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { args: string[]; ci: string | null })
    const pluginAddCalls = dshCalls.filter(call => call.args.includes('plugin') && call.args.includes('add'))
    expect(pluginAddCalls).toHaveLength(2)
    expect(pluginAddCalls.every(call => call.ci === 'true')).toBe(true)
  }, 30_000)

  test('source-bound vs post-migration (--to-npm) RSI receipts and cohort checks', async () => {
    const dir = await trackTempDir(tmpdir(), 'dsh-rsi-migration-check-')
    const target = 'web'
    const coord = `rsi-web-${createHash('sha256').update(target).digest('hex').slice(0, 12)}`
    const receiptName = `.rsi-coordinator-${createHash('sha256').update(target).digest('hex').slice(0, 16)}.json`
    await mkdir(join(dir, 'rsi-authorities', target), { mode: 0o700, recursive: true })

    // Post-migration state: sourceRepository: null, rsi-local-cohorts removed, rsi-authorities preserved.
    await writeFile(join(dir, receiptName), JSON.stringify({
      schemaVersion: 1,
      targetProfile: target,
      coordinatorProfile: coord,
      version: '0.2.2',
      sourceRepository: null,
    }), { mode: 0o600 })

    const lifecycleConfig = await import(pathToFileURL(join(installDirectory, 'lifecycle-config.mjs')).href) as {
      readRsiCoordinatorReceipt: (input: { homePath: string; profile: string }) => Promise<{ sourceRepository: string | null; version: string }>
    }
    const receipt = await lifecycleConfig.readRsiCoordinatorReceipt({ homePath: dir, profile: target })
    expect(receipt.sourceRepository).toBeNull()
    expect(receipt.version).toBe('0.2.2')

    const hostProfile = await import(pathToFileURL(join(installDirectory, 'host-profile-update.mjs')).href) as {
      localCohortPins: (home: string, profile: string) => Promise<unknown>
    }
    expect(await hostProfile.localCohortPins(dir, target)).toBeNull()

    // Unmigrated frozen cohort: assertRsiPairUpgradeSource points operator to --to-npm.
    const lifecycleProfileSource = await readFile(join(installDirectory, 'lifecycle-profile.mjs'), 'utf8')
    expect(lifecycleProfileSource).toContain('源码/制品收据迁移')
    expect(lifecycleProfileSource).toContain('dsh-ray update --all --yes --to-npm')
  })
})
