import { execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { closeSync, openSync, readSync, renameSync } from 'node:fs'
import { access, chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { previewCatalogAdmission } from '../plugins/plugin-control-plane/src/catalog.ts'
import { controlPlaneDigest } from '../plugins/plugin-control-plane/src/store.ts'
import {
  parseSourceReleaseRequest,
  parseSourceReleaseReceipt,
  parseSourcePublishReconciliationReceipt,
  invokeSourceReleaseAdapter,
  sourceArtifactSigningPayload,
  sourceReleaseAuthorizationSigningPayload,
  sourceReleaseEvidenceDigest,
  sourceReleaseRequestDigest,
  sourceReleaseSigningPayload,
  sourcePublishReconciliationEvidenceDigest,
  sourcePublishReconciliationRequestDigest,
  sourcePublishReconciliationSigningPayload,
} from '../plugins/plugin-control-plane/src/release.ts'
import { defaultHostAttestationPolicy, type PluginControlTrustConfig } from '../plugins/plugin-control-plane/src/trust.ts'
import type {
  SourceReleaseAdapterIdentity,
  SourceReleaseArtifact,
  SourceReleaseAuthorization,
  SourceReleasePhase,
  SourceReleasePolicy,
  SourceReleaseReceipt,
  SourceReleaseRequest,
  SourceReleaseSuccessEvidence,
  SourcePublishReconciliationReceipt,
  SourcePublishReconciliationRequest,
  VerifiedSourceReleaseAuthorization,
} from '../plugins/plugin-control-plane/src/types.ts'

const repositoryRoot = resolve(import.meta.dirname, '..')
const adapterSource = join(repositoryRoot, 'plugins', 'plugin-control-plane', 'bin', 'dsh-local-release-adapter.js')
const timeoutFixtureSource = join(repositoryRoot, 'tests', 'fixtures', 'release-adapter-timeout-after-publish.mjs')
const gitPath = '/usr/bin/git'
const tarPath = '/usr/bin/tar'
const sandboxPath = '/usr/bin/bwrap'
const installationId = '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00'
const ledgerId = '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01'
const adapterVersion = 'dsh-local-release-adapter-1'
const roots: string[] = []

function digestBytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function workspacePnpmVersion(): Promise<string> {
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')) as unknown
  } catch (error) {
    throw new Error(`release fixture cannot read the workspace packageManager: ${errorMessage(error)}`)
  }
  const packageManager = typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest)
    ? (manifest as Record<string, unknown>).packageManager
    : undefined
  const match = typeof packageManager === 'string'
    ? /^pnpm@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?)$/u.exec(packageManager)
    : null
  if (match?.[1] === undefined) {
    throw new Error(`release fixture requires packageManager to be an exact pnpm version, received ${JSON.stringify(packageManager)}`)
  }
  return match[1]
}

async function validateNativePnpmRoot(candidate: string, expectedVersion: string): Promise<string> {
  const root = await realpath(candidate)
  const rootMetadata = await lstat(root)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error('root is not a canonical directory')
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as unknown
  } catch (error) {
    throw new Error(`package.json is unavailable or invalid: ${errorMessage(error)}`)
  }
  const record = typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest)
    ? manifest as Record<string, unknown>
    : {}
  if (record.name !== '@pnpm/exe') throw new Error(`package name is ${JSON.stringify(record.name)}, not "@pnpm/exe"`)
  if (record.version !== expectedVersion) {
    throw new Error(`package version is ${JSON.stringify(record.version)}, not ${JSON.stringify(expectedVersion)}`)
  }
  const executablePath = join(root, 'pnpm')
  const executableMetadata = await lstat(executablePath)
  if (!executableMetadata.isFile() || executableMetadata.isSymbolicLink() || (executableMetadata.mode & 0o111) === 0) {
    throw new Error('pnpm entrypoint is not an executable regular file')
  }
  const descriptor = openSync(executablePath, 'r')
  try {
    const header = Buffer.alloc(4)
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length
      || !header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      throw new Error('pnpm entrypoint is not a native ELF executable')
    }
  } finally {
    closeSync(descriptor)
  }
  const reportedVersion = execFileSync(executablePath, ['--version'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
    timeout: 10_000,
  }).trim()
  if (reportedVersion !== expectedVersion) {
    throw new Error(`pnpm executable reports ${JSON.stringify(reportedVersion)}, not ${JSON.stringify(expectedVersion)}`)
  }
  return root
}

async function resolveNativePnpmRoot(expectedVersion: string): Promise<string> {
  const configuredRoot = process.env.DSH_TEST_PNPM_ROOT?.trim()
  if (configuredRoot !== undefined && configuredRoot !== '') {
    if (!isAbsolute(configuredRoot)) throw new Error('DSH_TEST_PNPM_ROOT must be an absolute path')
    try {
      return await validateNativePnpmRoot(configuredRoot, expectedVersion)
    } catch (error) {
      throw new Error(`DSH_TEST_PNPM_ROOT is not a native pnpm@${expectedVersion} toolchain: ${errorMessage(error)}`)
    }
  }

  const homes = new Set<string>()
  if (process.env.PNPM_HOME?.trim()) homes.add(resolve(process.env.PNPM_HOME))
  for (const entry of process.env.PATH?.split(delimiter) ?? []) {
    if (entry.trim() !== '') homes.add(resolve(entry))
  }
  const candidates = new Set<string>()
  for (const home of homes) {
    const versionsRoot = join(home, '.tools', '@pnpm+exe')
    candidates.add(join(versionsRoot, expectedVersion, 'node_modules', '@pnpm', 'exe'))
    try {
      for (const entry of await readdir(versionsRoot, { withFileTypes: true })) {
        if (entry.name.startsWith(`${expectedVersion}_`)) {
          candidates.add(join(versionsRoot, entry.name, 'node_modules', '@pnpm', 'exe'))
        }
      }
    } catch {
      // A PATH entry need not be a pnpm home. Only validated candidates are accepted below.
    }
  }

  const rejected: string[] = []
  const validated = new Set<string>()
  for (const candidate of candidates) {
    try {
      validated.add(await validateNativePnpmRoot(candidate, expectedVersion))
    } catch (error) {
      rejected.push(`${candidate}: ${errorMessage(error)}`)
    }
  }
  const [selected] = [...validated].sort()
  if (selected !== undefined) return selected
  const detail = rejected.length === 0 ? 'no pnpm homes were available' : rejected.join('; ')
  throw new Error(`release fixture requires a local native @pnpm/exe ${expectedVersion} toolchain; `
    + `set DSH_TEST_PNPM_ROOT to its package root. No download fallback is allowed. Tried: ${detail}`)
}

async function hardenToolchain(root: string): Promise<void> {
  const canonicalRoot = await realpath(root)
  const uid = process.getuid?.()
  const insideRoot = (path: string): boolean => path === canonicalRoot || path.startsWith(`${canonicalRoot}${sep}`)
  const visit = async (directory: string): Promise<void> => {
    await chmod(directory, 0o700)
    const directoryMetadata = await lstat(directory)
    if (uid !== undefined && directoryMetadata.uid !== uid) throw new Error(`fixture toolchain is not owned by uid ${uid}: ${directory}`)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name)
      const metadata = await lstat(entryPath)
      if (uid !== undefined && metadata.uid !== uid) throw new Error(`fixture toolchain is not owned by uid ${uid}: ${entryPath}`)
      if (metadata.isDirectory()) await visit(entryPath)
      else if (metadata.isFile()) await chmod(entryPath, metadata.mode & 0o755)
      else if (metadata.isSymbolicLink()) {
        const target = await readlink(entryPath)
        if (isAbsolute(target) || !insideRoot(resolve(dirname(entryPath), target))) {
          throw new Error(`fixture toolchain contains an escaping symlink: ${entryPath} -> ${target}`)
        }
        const resolvedTarget = await realpath(entryPath)
        if (!insideRoot(resolvedTarget)) throw new Error(`fixture toolchain symlink escapes its root: ${entryPath}`)
      } else throw new Error(`fixture toolchain contains an unsupported entry: ${entryPath}`)
    }
  }
  await visit(canonicalRoot)
  await chmod(join(canonicalRoot, 'pnpm'), 0o700)

  const verify = async (directory: string): Promise<void> => {
    const directoryMetadata = await lstat(directory)
    if ((directoryMetadata.mode & 0o777) !== 0o700) throw new Error(`fixture toolchain directory is not owner-private: ${directory}`)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name)
      const metadata = await lstat(entryPath)
      if (metadata.isDirectory()) await verify(entryPath)
      else if (metadata.isFile() && (metadata.mode & 0o022) !== 0) {
        throw new Error(`fixture toolchain file is group/other writable: ${entryPath}`)
      }
    }
  }
  await verify(canonicalRoot)
  const pnpmMetadata = await lstat(join(canonicalRoot, 'pnpm'))
  if ((pnpmMetadata.mode & 0o777) !== 0o700 || pnpmMetadata.nlink !== 1) {
    throw new Error('fixture pnpm must be owner-private and independent')
  }
}

async function rewriteNodeShebang(path: string, nodePath: string): Promise<void> {
  const contents = await readFile(path, 'utf8')
  const firstNewline = contents.indexOf('\n')
  if (!contents.startsWith('#!') || firstNewline === -1) throw new Error(`fixture script has no shebang: ${path}`)
  await writeFile(path, `#!${nodePath}${contents.slice(firstNewline)}`)
}

function git(args: readonly string[], cwd?: string, environment: NodeJS.ProcessEnv = {}): string {
  return execFileSync(gitPath, [...args], {
    cwd,
    encoding: 'utf8',
    env: { LANG: 'C', LC_ALL: 'C', ...environment },
  }).trim()
}

async function executable(path: string): Promise<{ path: string; sha256: string }> {
  return { path: await realpath(path), sha256: digestBytes(await readFile(path)) }
}

async function directoryDigest(path: string): Promise<string> {
  const inventory: Array<{ path: string; type: 'directory' | 'file' | 'symlink'; mode?: number; bytes?: number; sha256?: string; target?: string }> = []
  const visit = async (directory: string, prefix = ''): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const entryPath = join(directory, entry.name); const entryName = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const metadata = await lstat(entryPath)
      if (metadata.isDirectory()) { inventory.push({ path: entryName, type: 'directory', mode: metadata.mode & 0o777 }); await visit(entryPath, entryName) }
      else if (metadata.isFile()) { const bytes = await readFile(entryPath); inventory.push({ path: entryName, type: 'file', mode: metadata.mode & 0o777,
        bytes: bytes.length, sha256: digestBytes(bytes) }) }
      else if (metadata.isSymbolicLink()) inventory.push({ path: entryName, type: 'symlink', target: await readlink(entryPath) })
      else throw new Error(`fixture toolchain contains unsupported entry: ${entryPath} mode=${metadata.mode.toString(8)}`)
    }
  }
  await visit(path)
  return controlPlaneDigest(inventory)
}

async function writeJson(path: string, value: unknown, mode = 0o600): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode })
  await chmod(path, mode)
}

interface RoleFixture {
  phase: SourceReleasePhase
  directory: string
  executable: string
  configPath: string
  environmentName: string
  privateKey: KeyObject
  publicKeyPem: string
  identity: SourceReleaseAdapterIdentity
}

interface ReleaseFixture {
  root: string
  nodePath: string
  source: string
  worktree: string
  remote: string
  baseCommit: string
  catalogPath: string
  registryRoot: string
  downloadRoot: string
  reviewStore: string
  reviewDecisionRoot: string
  buildPnpmPath: string
  pnpmVersion: string
  scope: readonly string[]
  treeDigest: string
  patchDigest: string
  policy: SourceReleasePolicy
  authorization: VerifiedSourceReleaseAuthorization
  roles: Record<SourceReleasePhase, RoleFixture>
}

async function checkedSnapshot(worktree: string, baseCommit: string, scope: readonly string[], root: string) {
  const index = join(root, 'checked.index')
  const environment = { GIT_INDEX_FILE: index, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  git(['read-tree', baseCommit], worktree, environment)
  git(['--literal-pathspecs', 'add', '--all', '--', ...scope], worktree, environment)
  const tree = execFileSync(gitPath, ['--literal-pathspecs', '-c', 'core.quotepath=false', 'ls-files', '--stage', '-z', '--', ...scope], {
    cwd: worktree,
    env: { LANG: 'C', LC_ALL: 'C', ...environment },
  })
  const patch = execFileSync(gitPath, [
    '--literal-pathspecs', '-c', 'core.quotepath=false', 'diff', '--cached', '--binary', '--full-index', '--no-color', baseCommit, '--', ...scope,
  ], {
    cwd: worktree,
    env: { LANG: 'C', LC_ALL: 'C', ...environment },
  })
  const binding = Buffer.from(`${baseCommit}\0${JSON.stringify(scope)}\0`)
  return {
    treeDigest: createHash('sha256').update('dsh-source-tree-v2\0').update(binding).update(tree).digest('hex'),
    patchDigest: createHash('sha256').update('dsh-source-patch-v2\0').update(binding).update(patch).digest('hex'),
  }
}

async function createFixture(): Promise<ReleaseFixture> {
  const pnpmVersion = await workspacePnpmVersion()
  const pnpmSourceRoot = await resolveNativePnpmRoot(pnpmVersion)
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-adapter-'))
  roots.push(root)
  await chmod(root, 0o700)
  const nodePath = join(root, 'node')
  await copyFile(await realpath(process.execPath), nodePath)
  await chmod(nodePath, 0o700)
  const nodeMetadata = await lstat(nodePath)
  if (!nodeMetadata.isFile() || nodeMetadata.isSymbolicLink() || nodeMetadata.nlink !== 1
    || (nodeMetadata.mode & 0o777) !== 0o700) {
    throw new Error('release fixture Node must be an owner-private independent regular file')
  }
  const source = join(root, 'source')
  const worktree = join(root, 'worktree')
  const remote = join(root, 'remote.git')
  const registryRoot = join(root, 'registry')
  const downloadRoot = join(root, 'downloads')
  const reviewStore = join(root, 'reviews')
  const reviewDecisionRoot = join(root, 'review-decisions')
  const catalogPath = join(root, 'catalog.json')
  const rolesRoot = join(root, 'roles')
  const toolchainRoot = join(root, 'toolchain')
  const pnpmRoot = toolchainRoot
  const buildNodePath = join(toolchainRoot, 'node')
  const buildPnpmPath = join(toolchainRoot, 'pnpm')
  const storeRoot = join(root, 'pnpm-store')
  await Promise.all([
    mkdir(source, { mode: 0o700 }),
    mkdir(registryRoot, { mode: 0o700 }),
    mkdir(downloadRoot, { mode: 0o700 }),
    mkdir(reviewStore, { mode: 0o700 }),
    mkdir(reviewDecisionRoot, { mode: 0o700 }),
    mkdir(rolesRoot, { mode: 0o700 }),
    mkdir(storeRoot, { mode: 0o700 }),
  ])
  await cp(pnpmSourceRoot, pnpmRoot, { recursive: true })
  await copyFile(nodePath, buildNodePath)
  const originalPnpm = join(pnpmRoot, 'pnpm'); const copiedPnpm = join(pnpmRoot, '.pnpm-copy')
  await copyFile(originalPnpm, copiedPnpm); await rm(originalPnpm); await writeFile(originalPnpm, await readFile(copiedPnpm), { mode: 0o700 }); await rm(copiedPnpm)
  await hardenToolchain(pnpmRoot)
  await validateNativePnpmRoot(pnpmRoot, pnpmVersion)
  const storeVersion = Number.parseInt(pnpmVersion.split('.')[0] ?? '', 10)
  if (!Number.isSafeInteger(storeVersion)) throw new Error('fixture pnpm version is invalid')
  await Promise.all(['files', 'projects'].map(name => mkdir(join(storeRoot, `v${storeVersion}`, name), { recursive: true, mode: 0o700 })))
  execFileSync(nodePath, ['-e', "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec('CREATE TABLE package_index (key TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID');d.close()",
    join(storeRoot, `v${storeVersion}`, 'index.db')], { env: { LANG: 'C', LC_ALL: 'C', HOME: root, PATH: '/usr/bin:/bin' }, stdio: 'ignore' })
  await writeJson(join(rolesRoot, 'package.json'), { type: 'module' })
  git(['init', '--initial-branch=main'], source)
  await mkdir(join(source, 'plugins', 'fixture-capability', 'src'), { recursive: true, mode: 0o700 })
  await writeFile(join(source, 'plugins', 'README.md'), '# Plugins\n', { mode: 0o644 })
  await writeJson(join(source, 'plugins', 'fixture-capability', 'package.json'), {
    name: '@fixture/capability', version: '1.0.0', description: 'Release adapter fixture DSH plugin.', license: 'MIT', type: 'module',
    main: './lib/index.js', exports: { '.': './lib/index.js', './cordis.patch.yml': './cordis.patch.yml', './package.json': './package.json' },
    files: ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE'], scripts: { build: 'node ./build.mjs', prepack: 'pnpm run build' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, 0o644)
  await writeFile(join(source, 'plugins', 'fixture-capability', 'src', 'index.js'), "export const value = 'base'\n", { mode: 0o644 })
  await writeFile(join(source, 'plugins', 'fixture-capability', 'build.mjs'), `import { copyFileSync, mkdirSync, readFileSync, readlinkSync } from 'node:fs'
if (process.cwd() !== '/workspace/plugins/fixture-capability' || process.env.HOME !== '/home'
  || process.env.TMPDIR !== '/tmp' || process.env.SOURCE_DATE_EPOCH !== '0') process.exit(9)
if (process.execPath !== '/toolchain/node') process.exit(11)
const hostNamespace = readFileSync('.host-netns', 'utf8').trim()
if (readlinkSync('/proc/self/ns/net') === hostNamespace) process.exit(10)
mkdirSync('lib', { recursive: true }); copyFileSync('src/index.js', 'lib/index.js')
`, { mode: 0o644 })
  await writeFile(join(source, 'plugins', 'fixture-capability', '.host-netns'),
    execFileSync('/usr/bin/readlink', ['/proc/self/ns/net'], { encoding: 'utf8' }), { mode: 0o644 })
  await writeFile(join(source, 'plugins', 'fixture-capability', 'cordis.patch.yml'),
    "- insert:\n    - id: fixture-capability\n      name: '@fixture/capability'\n", { mode: 0o644 })
  await writeFile(join(source, 'plugins', 'fixture-capability', 'README.md'), '# Fixture capability\n', { mode: 0o644 })
  await writeFile(join(source, 'plugins', 'fixture-capability', 'LICENSE'), 'MIT License fixture\n', { mode: 0o644 })
  await writeJson(join(source, 'package.json'), { name: 'fixture-workspace', private: true, packageManager: `pnpm@${pnpmVersion}`,
    scripts: { build: 'pnpm --recursive --if-present run build' } }, 0o644)
  await writeFile(join(source, 'pnpm-workspace.yaml'), "packages:\n  - plugins/*\n", { mode: 0o644 })
  await writeFile(join(source, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n  plugins/fixture-capability: {}\n", { mode: 0o644 })
  git(['add', '.'], source)
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'base'], source)
  const baseCommit = git(['rev-parse', 'HEAD'], source)
  git(['init', '--bare', remote])
  await chmod(remote, 0o700)
  git(['remote', 'add', 'origin', remote], source)
  git(['push', 'origin', 'main'], source)
  git(['worktree', 'add', '--detach', worktree, baseCommit], source)
  await writeFile(join(worktree, 'plugins', 'fixture-capability', 'src', 'index.js'), "export const value = 'released'\n", { mode: 0o644 })
  await writeFile(join(worktree, 'plugins', 'README.md'), '# Plugins\n\n- fixture-capability\n', { mode: 0o644 })
  const scope = ['plugins/README.md', 'plugins/fixture-capability'] as const
  const { treeDigest, patchDigest } = await checkedSnapshot(worktree, baseCommit, scope, root)
  await writeJson(catalogPath, { schemaVersion: 1, entries: [] })

  const policy: SourceReleasePolicy = {
    targetBranch: 'main',
    candidateId: 'fixture-capability',
    packageName: '@fixture/capability',
    packageVersion: '1.0.0',
    packagePath: 'plugins/fixture-capability',
    dshBaseline: '0.1.0',
    capabilities: ['fixture'],
    authorities: ['filesystem: fixture'],
    requires: [],
    registryId: 'local-registry',
    registryLocator: pathToFileURL(registryRoot).href,
    registryReference: pathToFileURL(join(registryRoot, 'packages', encodeURIComponent('@fixture/capability'), '1.0.0', 'package.tgz')).href,
    catalogId: 'owner-catalog',
    catalogPath,
    minimumReproducibleBuilds: 2,
  }
  const owner = generateKeyPairSync('ed25519')
  const unsignedAuthorization: Omit<SourceReleaseAuthorization, 'signature'> = {
    schemaVersion: 1,
    kind: 'dsh-source-release-authorization',
    authorizationId: 'authorization-fixture-1',
    authority: 'owner-review',
    keyId: 'owner-key-1',
    planId: 'source-plan-fixture',
    planDigest: '1'.repeat(64),
    baseCommit,
    checkedTreeDigest: treeDigest,
    checkedPatchDigest: patchDigest,
    scope,
    releasePolicy: policy,
    authorizedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 300_000,
  }
  const authorizationSignature = sign(
    null,
    Buffer.from(sourceReleaseAuthorizationSigningPayload(unsignedAuthorization)),
    owner.privateKey,
  ).toString('base64')
  const authorization: VerifiedSourceReleaseAuthorization = {
    ...unsignedAuthorization,
    signature: authorizationSignature,
    signatureDigest: digestBytes(Buffer.from(authorizationSignature, 'base64')),
  }

  const phases: readonly SourceReleasePhase[] = [
    'pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission',
  ]
  const generated = new Map<SourceReleasePhase, ReturnType<typeof generateKeyPairSync>>()
  for (const phase of phases) generated.set(phase, generateKeyPairSync('ed25519'))
  const gitExecutable = await executable(gitPath)
  const tarExecutable = await executable(tarPath)
  const sandboxExecutable = await executable(sandboxPath)
  const nodeDigest = digestBytes(await readFile(nodePath))
  const nodeExecutable = await executable(buildNodePath)
  const pnpmExecutable = await executable(buildPnpmPath)
  const pnpmRootPin = { path: await realpath(pnpmRoot), sha256: await directoryDigest(pnpmRoot) }
  const storeRootPin = { path: await realpath(storeRoot), sha256: await directoryDigest(storeRoot) }
  const roles = {} as Record<SourceReleasePhase, RoleFixture>
  for (const phase of phases) {
    const directory = join(rolesRoot, phase)
    const stateRoot = join(directory, 'state')
    await mkdir(stateRoot, { recursive: true, mode: 0o700 })
    const executablePath = join(directory, 'adapter.js')
    await copyFile(adapterSource, executablePath)
    await rewriteNodeShebang(executablePath, nodePath)
    await chmod(executablePath, 0o755)
    if (phase === 'catalog-admission') {
      const library = join(directory, '..', 'lib')
      await mkdir(library, { recursive: true, mode: 0o700 })
      await Promise.all(['catalog.js', 'catalog-interpreter.js'].map(name => copyFile(
        join(repositoryRoot, 'plugins', 'plugin-control-plane', 'lib', name),
        join(library, name),
      )))
    }
    const key = generated.get(phase)!
    const privateKeyPath = join(directory, 'private.pem')
    await writeFile(privateKeyPath, key.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
    const publicKeyPem = key.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const config: Record<string, unknown> = {
      schemaVersion: 1,
      id: 'local-' + phase,
      phase,
      executablePath,
      authority: phase + '-authority',
      keyId: phase + '-key',
      privateKeyPath,
      authorizationAuthority: { authority: 'owner-review', keyId: 'owner-key-1', publicKeyPath: join(directory, 'authorization-public.pem') },
      stateRoot,
    }
    await writeFile(join(directory, 'authorization-public.pem'), owner.publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o600 })
    if (['pr', 'review', 'merge', 'build'].includes(phase)) {
      Object.assign(config, {
        git: {
          executable: gitExecutable,
          remote,
          targetBranch: 'main',
          authorName: 'DSH Release Fixture',
          authorEmail: 'release@example.test',
          reviewStore,
          reviewDecisionRoot,
          ...(phase === 'merge' ? {
            reviewAuthority: {
              authority: 'review-authority',
              keyId: 'review-key',
              publicKeyPath: join(rolesRoot, 'merge', 'review-public.pem'),
            },
          } : {}),
        },
      })
    }
    if (phase === 'build') Object.assign(config, { build: { sandboxExecutable, tarExecutable, nodeExecutable, pnpmExecutable,
      pnpmRoot: pnpmRootPin, storeRoot: storeRootPin } })
    if (['publish', 'registry-verify', 'catalog-admission'].includes(phase)) {
      Object.assign(config, {
        registry: {
          id: 'local-registry',
          root: registryRoot,
          locator: pathToFileURL(registryRoot).href,
          ...(phase === 'registry-verify' ? { downloadRoot } : {}),
          signer: {
            authority: 'sign-authority',
            keyId: 'sign-key',
            publicKeyPath: join(directory, 'signer-public.pem'),
          },
        },
      })
    }
    if (phase === 'catalog-admission') {
      const helperPath = join(directory, '..', 'lib', 'catalog.js')
      Object.assign(config, {
        registryVerifier: { authority: 'registry-verify-authority', keyId: 'registry-verify-key',
          publicKeyPath: join(directory, 'registry-verifier-public.pem') },
        catalog: { id: 'owner-catalog', path: catalogPath, helper: { path: helperPath, sha256: digestBytes(await readFile(helperPath)) },
          interpreter: { path: nodePath, sha256: nodeDigest } },
      })
    }
    const configPath = join(directory, 'config.json')
    await writeJson(configPath, config)
    roles[phase] = {
      phase,
      directory,
      executable: executablePath,
      configPath,
      environmentName: 'DSH_RELEASE_' + phase.toUpperCase().replaceAll('-', '_') + '_CONFIG',
      privateKey: key.privateKey,
      publicKeyPem,
      identity: {
        id: 'local-' + phase,
        version: adapterVersion,
        path: executablePath,
        sha256: digestBytes(await readFile(executablePath)),
        interpreter: { path: nodePath, sha256: nodeDigest },
        authority: phase + '-authority',
        keyId: phase + '-key',
      },
    }
  }
  await writeFile(
    join(rolesRoot, 'merge', 'review-public.pem'),
    generated.get('review')!.publicKey.export({ format: 'pem', type: 'spki' }),
    { mode: 0o600 },
  )
  await Promise.all(['publish', 'registry-verify', 'catalog-admission'].map(phase => writeFile(
    join(rolesRoot, phase, 'signer-public.pem'),
    generated.get('sign')!.publicKey.export({ format: 'pem', type: 'spki' }),
    { mode: 0o600 },
  )))
  await writeFile(
    join(rolesRoot, 'catalog-admission', 'registry-verifier-public.pem'),
    generated.get('registry-verify')!.publicKey.export({ format: 'pem', type: 'spki' }),
    { mode: 0o600 },
  )
  return {
    root, nodePath, source, worktree, remote, baseCommit, catalogPath, registryRoot, downloadRoot, reviewStore, reviewDecisionRoot,
    buildPnpmPath, pnpmVersion, scope, treeDigest, patchDigest, policy, authorization, roles,
  }
}

function requestBase(target: ReleaseFixture, role: RoleFixture, phase: SourceReleasePhase, operationId: string) {
  return {
    schemaVersion: 1 as const,
    kind: 'dsh-source-release-request' as const,
    operationId,
    attempt: 1,
    requestedAt: Date.now() - 10,
    receiptTtlMs: 60_000,
    installationId,
    ledger: { id: ledgerId, path: join(target.root, 'ledger.sqlite') },
    plan: { id: 'source-plan-fixture', digest: '1'.repeat(64), revision: 4 },
    release: { id: 'release-fixture', fence: 1 },
    authorization: target.authorization,
    adapter: role.identity,
    registry: { id: 'local-registry', locator: pathToFileURL(target.registryRoot).href },
    catalog: { id: 'owner-catalog', path: target.catalogPath },
    phase,
  }
}

function runAdapter(
  target: ReleaseFixture,
  request: SourceReleaseRequest,
  timeout = 45_000,
  executablePath?: string,
  waitForReady = false,
): Promise<SourceReleaseReceipt> {
  const role = target.roles[request.phase]
  return new Promise((resolvePromise, reject) => {
    const artifact = 'artifact' in request.input ? request.input.artifact : undefined
    const descriptors = artifact === undefined ? [] : [artifact.tarballPath, artifact.sbomPath, artifact.provenancePath]
      .map(path => openSync(path, 'r'))
    const child = spawn(executablePath ?? role.executable, ['release'], {
      env: {
        [role.environmentName]: role.configPath,
        ...(artifact === undefined ? {} : { DSH_RELEASE_TARBALL_FD: '3', DSH_RELEASE_SBOM_FD: '4', DSH_RELEASE_PROVENANCE_FD: '5' }),
        ...(executablePath === undefined ? {} : {
          DSH_RELEASE_FIXTURE_MODULE: role.executable,
          DSH_RELEASE_FIXTURE_ROOT: join(target.root, 'publish-fault'),
          ...(waitForReady ? { DSH_RELEASE_FIXTURE_HANG_OPERATION: request.operationId } : {}),
        }),
      },
      stdio: ['pipe', 'pipe', 'pipe', ...descriptors],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', chunk => stdout.push(chunk))
    let ready = false
    let timeoutTimer: NodeJS.Timeout | undefined
    const armTimeout = () => {
      if (timeoutTimer !== undefined) return
      timeoutTimer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeout)
    }
    child.stderr.on('data', chunk => {
      stderr.push(chunk)
      if (waitForReady && !ready && Buffer.concat(stderr).includes(Buffer.from('DSH_RELEASE_FIXTURE_READY\n'))) { ready = true; armTimeout() }
    })
    let timedOut = false
    if (!waitForReady) armTimeout()
    child.once('close', code => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      for (const descriptor of descriptors) closeSync(descriptor)
      const error = Buffer.concat(stderr).toString('utf8')
      if (timedOut) reject(new Error('adapter timeout'))
      else if (waitForReady && !ready) reject(new Error(error || 'adapter exited before publish ready marker'))
      else if (code !== 0) reject(new Error(error || 'adapter exited ' + String(code)))
      else {
        try {
          resolvePromise(parseSourceReleaseReceipt(JSON.parse(Buffer.concat(stdout).toString('utf8'))))
        } catch (caught) {
          reject(caught)
        }
      }
    })
    child.stdin.end(JSON.stringify(request) + '\n')
  })
}
function runReconciliationAdapter(target: ReleaseFixture, request: SourcePublishReconciliationRequest): Promise<SourcePublishReconciliationReceipt> {
  const role = target.roles['registry-verify']
  return new Promise((resolvePromise, reject) => {
    const child = spawn(role.executable, ['reconcile'], { env: { [role.environmentName]: role.configPath }, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []; const stderr: Buffer[] = []
    child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk))
    child.once('close', code => {
      if (code !== 0) reject(new Error(Buffer.concat(stderr).toString('utf8') || 'reconciliation adapter failed'))
      else { try { resolvePromise(parseSourcePublishReconciliationReceipt(JSON.parse(Buffer.concat(stdout).toString('utf8')))) } catch (error) { reject(error) } }
    })
    child.stdin.end(JSON.stringify(request) + '\n')
  })
}
async function invokePinnedAdapter(target: ReleaseFixture, request: SourceReleaseRequest): Promise<SourceReleaseReceipt> {
  const role = target.roles[request.phase]; const previous = process.env[role.environmentName]
  process.env[role.environmentName] = role.configPath
  const trust: PluginControlTrustConfig = { schemaVersion: 4, installationId, dshHome: target.root, ledger: request.ledger,
    executor: { id: 'unused', version: '1.0.0', path: target.nodePath,
      sha256: digestBytes(await readFile(target.nodePath)), environmentAllowlist: [] },
    hostPolicy: defaultHostAttestationPolicy, catalog: request.catalog, releaseRegistry: request.registry, releaseReceiptTtlMs: 60_000,
    releaseAdapters: { [request.phase]: { ...role.identity, environmentAllowlist: [role.environmentName], timeoutMs: 45_000 } },
    approvalKeys: [], hostAttestationKeys: [], releaseKeys: [], releaseAuthorizationKeys: [] }
  try { return await invokeSourceReleaseAdapter(trust, request) } finally {
    if (previous === undefined) delete process.env[role.environmentName]; else process.env[role.environmentName] = previous
  }
}

function verifyReceipt(request: SourceReleaseRequest, receipt: SourceReleaseReceipt, role: RoleFixture): void {
  expect(receipt.requestDigest).toBe(sourceReleaseRequestDigest(parseSourceReleaseRequest(request)))
  expect(receipt.evidenceDigest).toBe(sourceReleaseEvidenceDigest(receipt.evidence))
  expect(receipt.authority).toBe(role.identity.authority)
  expect(receipt.keyId).toBe(role.identity.keyId)
  const { signature, ...unsigned } = receipt
  expect(verify(
    null,
    Buffer.from(sourceReleaseSigningPayload(unsigned)),
    role.publicKeyPem,
    Buffer.from(signature, 'base64'),
  )).toBe(true)
}

function success(receipt: SourceReleaseReceipt): SourceReleaseSuccessEvidence {
  expect(receipt.outcome).toBe('passed')
  if (receipt.evidence.kind === 'failure' || receipt.evidence.kind === 'publish-ambiguity') {
    throw new Error('unexpected release failure')
  }
  return receipt.evidence
}

function resignReceipt(receipt: SourceReleaseReceipt, privateKey: KeyObject): SourceReleaseReceipt {
  const { signature: _signature, ...unsigned } = receipt
  return { ...unsigned, signature: sign(null, Buffer.from(sourceReleaseSigningPayload(unsigned)), privateKey).toString('base64') }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('owner-controlled local release adapter', () => {
  test('runs a real independent git/build/sign/immutable-registry/catalog release with permanent replay', async () => {
    const target = await createFixture()
    const distinctPaths = new Set(Object.values(target.roles).map(role => role.identity.path))
    const distinctKeys = new Set(Object.values(target.roles).map(role => role.identity.authority + ':' + role.identity.keyId))
    const distinctPublicKeys = new Set(Object.values(target.roles).map(role => role.publicKeyPem))
    expect(distinctPaths.size).toBe(8)
    expect(distinctKeys.size).toBe(8)
    expect(distinctPublicKeys.size).toBe(8)
    expect(execFileSync(target.roles.pr.executable, ['--version'], { encoding: 'utf8', env: {} }).trim()).toBe(adapterVersion)
    expect(JSON.parse(execFileSync(target.roles.pr.executable, ['--capabilities'], { encoding: 'utf8', env: {} })))
      .toEqual({ schemaVersion: 1, artifactInput: 'inherited-fd-v1' })

    const prRequest = parseSourceReleaseRequest({
      ...requestBase(target, target.roles.pr, 'pr', 'release-operation-pr'),
      input: {
        repository: target.source,
        worktree: target.worktree,
        baseCommit: target.baseCommit,
        name: 'fixture-capability',
        scope: target.scope,
        expectedTreeDigest: target.treeDigest,
        expectedPatchDigest: target.patchDigest,
      },
    })
    await expect(invokePinnedAdapter(target, prRequest)).resolves.toMatchObject({ phase: 'pr', outcome: 'passed' })
    const prReceipt = await runAdapter(target, prRequest)
    verifyReceipt(prRequest, prReceipt, target.roles.pr)
    const pr = success(prReceipt)
    expect(pr).toMatchObject({ kind: 'pr', treeDigest: target.treeDigest, patchDigest: target.patchDigest })
    if (pr.kind !== 'pr') throw new Error('missing PR evidence')
    expect(git(['--git-dir', target.remote, 'show-ref', '--verify', '--hash', 'refs/dsh-release/pulls/' + pr.prId + '/head']))
      .toBe(pr.headCommit)
    await writeJson(join(target.reviewDecisionRoot, pr.prId + '.json'), { schemaVersion: 1, kind: 'dsh-local-review-decision',
      prId: pr.prId, baseCommit: pr.baseCommit, headCommit: pr.headCommit, prEvidenceDigest: prReceipt.evidenceDigest,
      decision: 'approved', reviewerPrincipal: 'reviewer@example.test' })

    const reviewRequest = parseSourceReleaseRequest({
      ...requestBase(target, target.roles.review, 'review', 'release-operation-review'),
      input: {
        prId: pr.prId,
        headCommit: pr.headCommit,
        baseCommit: pr.baseCommit,
        prEvidenceDigest: prReceipt.evidenceDigest,
      },
    })
    const reviewReceipt = await runAdapter(target, reviewRequest)
    verifyReceipt(reviewRequest, reviewReceipt, target.roles.review)
    const review = success(reviewReceipt)
    if (review.kind !== 'review') throw new Error('missing review evidence')
    expect(await stat(join(target.reviewStore, review.reviewId + '.json'))).toMatchObject({ mode: expect.any(Number) })

    const mergeRequest = parseSourceReleaseRequest({
      ...requestBase(target, target.roles.merge, 'merge', 'release-operation-merge'),
      input: {
        prId: pr.prId,
        headCommit: pr.headCommit,
        reviewId: review.reviewId,
        reviewEvidenceDigest: reviewReceipt.evidenceDigest,
        targetBranch: 'main',
      },
    })
    const mergeReceipt = await runAdapter(target, mergeRequest)
    verifyReceipt(mergeRequest, mergeReceipt, target.roles.merge)
    const merge = success(mergeReceipt)
    if (merge.kind !== 'merge') throw new Error('missing merge evidence')
    expect(git(['--git-dir', target.remote, 'rev-parse', 'refs/heads/main'])).toBe(merge.mergeCommit)

    const buildRequest = parseSourceReleaseRequest({
      ...requestBase(target, target.roles.build, 'build', 'release-operation-build'),
      input: {
        repository: target.source,
        mergeCommit: merge.mergeCommit,
        mergeEvidenceDigest: mergeReceipt.evidenceDigest,
        name: 'fixture-capability',
        expectedCandidateId: target.policy.candidateId,
        expectedPackageName: target.policy.packageName,
        expectedPackageVersion: target.policy.packageVersion,
        expectedPackagePath: target.policy.packagePath,
        expectedDshBaseline: target.policy.dshBaseline,
        expectedCapabilities: target.policy.capabilities,
        expectedAuthorities: target.policy.authorities,
        expectedRequires: target.policy.requires,
      },
    })
    // Snapshot copies must preserve the owner-pinned mode bits even when the
    // release worker runs with a restrictive production-style umask.
    const previousUmask = process.umask(0o077)
    let buildReceipt: SourceReleaseReceipt
    try {
      buildReceipt = await runAdapter(target, buildRequest)
    } finally {
      process.umask(previousUmask)
    }
    verifyReceipt(buildRequest, buildReceipt, target.roles.build)
    const build = success(buildReceipt)
    if (build.kind !== 'build') throw new Error('missing build evidence')
    expect(build).toMatchObject({
      isolated: true,
      reproducibleBuilds: 2,
      firstBuildSha256: build.tarballSha256,
      secondBuildSha256: build.tarballSha256,
    })
    const tarballBytes = await readFile(build.tarballPath)
    expect(build.tarballIntegrity).toBe(`sha512-${createHash('sha512').update(tarballBytes).digest('base64')}`)
    const archiveEntries = execFileSync(tarPath, ['-tzf', build.tarballPath], { encoding: 'utf8' }).trim().split('\n').sort()
    expect(archiveEntries).toEqual([
      'package/LICENSE',
      'package/README.md',
      'package/cordis.patch.yml',
      'package/lib/index.js',
      'package/package.json',
    ])
    expect(archiveEntries.some(path => path.startsWith('package/src/') || path.startsWith('package/tests/')
      || path.includes('tsconfig') || path.includes('build.mjs') || path.includes('pnpm-lock'))).toBe(false)
    for (const index of [1, 2]) {
      expect(await readFile(join(target.roles.build.directory, 'state', 'operations', digestBytes(buildRequest.operationId),
        `build-${index}`, 'workspace', 'plugins', 'fixture-capability', 'lib', 'index.js'), 'utf8')).toContain("value = 'released'")
    }
    await expect(access(join(target.source, 'plugins', 'fixture-capability', 'lib'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(build.sbomPath, 'utf8'))).toMatchObject({ bomFormat: 'CycloneDX' })
    expect(JSON.parse(await readFile(build.provenancePath, 'utf8'))).toMatchObject({
      predicateType: 'https://slsa.dev/provenance/v1',
    })
    const artifact: SourceReleaseArtifact = {
      candidateId: build.candidateId,
      sourceName: build.sourceName,
      packagePath: build.packagePath,
      packageName: build.packageName,
      packageVersion: build.packageVersion,
      tarballPath: build.tarballPath,
      tarballBytes: build.tarballBytes,
      tarballSha256: build.tarballSha256,
      tarballIntegrity: build.tarballIntegrity,
      sbomPath: build.sbomPath,
      sbomSha256: build.sbomSha256,
      provenancePath: build.provenancePath,
      provenanceSha256: build.provenanceSha256,
      mergedCommit: build.mergedCommit,
      dshBaseline: build.dshBaseline,
      capabilities: build.capabilities,
      authorities: build.authorities,
      requires: build.requires,
    }

    const signRequest = parseSourceReleaseRequest({
      ...requestBase(target, target.roles.sign, 'sign', 'release-operation-sign'),
      input: { artifact, buildEvidenceDigest: buildReceipt.evidenceDigest },
    })
    const signReceipt = await invokePinnedAdapter(target, signRequest)
    verifyReceipt(signRequest, signReceipt, target.roles.sign)
    const signed = success(signReceipt)
    if (signed.kind !== 'sign') throw new Error('missing sign evidence')
    expect(verify(
      null,
      Buffer.from(sourceArtifactSigningPayload(artifact)),
      target.roles.sign.publicKeyPem,
      Buffer.from(signed.artifactSignature, 'base64'),
    )).toBe(true)

    const publishRequest = parseSourceReleaseRequest({
      ...requestBase(target, target.roles.publish, 'publish', 'release-operation-publish'),
      input: {
        artifact,
        artifactStatementDigest: signed.artifactStatementDigest,
        artifactSignature: signed.artifactSignature,
        signEvidenceDigest: signReceipt.evidenceDigest,
      },
    })
    const timeoutPath = join(target.roles.publish.directory, 'timeout-wrapper.mjs')
    await copyFile(timeoutFixtureSource, timeoutPath)
    await rewriteNodeShebang(timeoutPath, target.nodePath)
    await chmod(timeoutPath, 0o755)
    await expect(runAdapter(target, publishRequest, 50, timeoutPath, true)).rejects.toThrow('adapter timeout')
    expect((await stat(new URL(target.policy.registryReference))).size).toBe(build.tarballBytes)
    const recoveredPublishReceipt = await runAdapter(target, publishRequest, 2_000, timeoutPath)
    verifyReceipt(publishRequest, recoveredPublishReceipt, target.roles.publish)
    expect(success(recoveredPublishReceipt)).toMatchObject({ kind: 'publish', registryReference: target.policy.registryReference })
    const registryTarball = await readFile(new URL(target.policy.registryReference))
    expect(`sha512-${createHash('sha512').update(registryTarball).digest('base64')}`).toBe(artifact.tarballIntegrity)
    const installProfile = join(target.root, 'install-profile'); await mkdir(installProfile, { mode: 0o700 })
    const installHome = join(target.root, 'install-home'); await mkdir(installHome, { mode: 0o700 })
    await writeJson(join(installProfile, 'package.json'), { name: 'install-profile', private: true, type: 'module',
      packageManager: `pnpm@${target.pnpmVersion}` }, 0o600)
    execFileSync(target.buildPnpmPath, ['add', '--offline', '--ignore-scripts', '--package-import-method=copy',
      `file:${fileURLToPath(target.policy.registryReference)}`], { cwd: installProfile, env: { LANG: 'C', LC_ALL: 'C', HOME: installHome,
        PATH: `/usr/bin:/bin` }, stdio: 'ignore' })
    const installedManifestPath = join(installProfile, 'node_modules', '@fixture', 'capability', 'package.json')
    const installedManifest = JSON.parse(await readFile(installedManifestPath, 'utf8')) as { dsh?: { bundle?: { patch?: string } } }
    expect(installedManifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(await readFile(join(dirname(installedManifestPath), 'cordis.patch.yml'), 'utf8')).toContain("name: '@fixture/capability'")
    expect(await import(pathToFileURL(join(dirname(installedManifestPath), 'lib', 'index.js')).href)).toMatchObject({ value: 'released' })
    expect(await runAdapter(target, publishRequest)).toEqual(recoveredPublishReceipt)

    const ambiguousPublishRequest = parseSourceReleaseRequest({ ...publishRequest, operationId: 'release-operation-publish-ambiguous',
      requestedAt: Date.now() - 10 })
    const ambiguousReceipt = await runAdapter(target, ambiguousPublishRequest, 2_000, timeoutPath)
    expect(ambiguousReceipt).toMatchObject({ phase: 'publish', outcome: 'ambiguous', operationId: ambiguousPublishRequest.operationId })
    expect(ambiguousReceipt.operationId).toBe(ambiguousPublishRequest.operationId)
    verifyReceipt(ambiguousPublishRequest, ambiguousReceipt, target.roles.publish)
    const reconciliationRequest: SourcePublishReconciliationRequest = { schemaVersion: 1, kind: 'dsh-source-publish-reconciliation-request',
      operationId: 'publish-reconciliation-fixture', attempt: 1, requestedAt: Date.now() - 10, receiptTtlMs: 60_000, installationId,
      ledger: publishRequest.ledger, plan: publishRequest.plan, release: publishRequest.release, authorization: target.authorization,
      adapter: target.roles['registry-verify'].identity, registry: publishRequest.registry, ambiguousPublish: { operationId: ambiguousPublishRequest.operationId,
        receiptId: ambiguousReceipt.receiptId, receiptDigest: controlPlaneDigest(ambiguousReceipt), evidenceDigest: ambiguousReceipt.evidenceDigest },
      artifact: { packageName: artifact.packageName, packageVersion: artifact.packageVersion, tarballSha256: artifact.tarballSha256,
        tarballIntegrity: artifact.tarballIntegrity }, expectedRegistryReference: target.policy.registryReference,
      expectedArtifactStatementDigest: signed.artifactStatementDigest, expectedArtifactSignatureDigest: signed.artifactSignatureDigest }
    const reconciliationReceipt = await runReconciliationAdapter(target, reconciliationRequest)
    expect(reconciliationReceipt.evidence).toMatchObject({ outcome: 'exists-match', registryReference: target.policy.registryReference,
      expectedTarballSha256: artifact.tarballSha256, observedTarballSha256: artifact.tarballSha256,
      expectedArtifactStatementDigest: signed.artifactStatementDigest, observedArtifactStatementDigest: signed.artifactStatementDigest,
      expectedArtifactSignatureDigest: signed.artifactSignatureDigest, observedArtifactSignatureDigest: signed.artifactSignatureDigest,
      ambiguousPublishOperationId: ambiguousPublishRequest.operationId, ambiguousPublishReceiptDigest: reconciliationRequest.ambiguousPublish.receiptDigest })
    expect(reconciliationReceipt.requestDigest).toBe(sourcePublishReconciliationRequestDigest(reconciliationRequest))
    expect(reconciliationReceipt.evidenceDigest).toBe(sourcePublishReconciliationEvidenceDigest(reconciliationReceipt.evidence))
    const { signature: reconciliationSignature, ...reconciliationUnsigned } = reconciliationReceipt
    expect(verify(null, Buffer.from(sourcePublishReconciliationSigningPayload(reconciliationUnsigned)),
      target.roles['registry-verify'].publicKeyPem, Buffer.from(reconciliationSignature, 'base64'))).toBe(true)
    expect(await runReconciliationAdapter(target, reconciliationRequest)).toEqual(reconciliationReceipt)
    await expect(runReconciliationAdapter(target, { ...reconciliationRequest, requestedAt: reconciliationRequest.requestedAt + 1 }))
      .rejects.toThrow('different request')
    expect(await runAdapter(target, ambiguousPublishRequest)).toEqual(ambiguousReceipt)
    await expect(runAdapter(target, { ...ambiguousPublishRequest, requestedAt: ambiguousPublishRequest.requestedAt + 1 }))
      .rejects.toThrow('different request')
    const registryReference = reconciliationReceipt.evidence.registryReference
    if (registryReference === null) throw new Error('reconciliation did not return a registry reference')

    const verifyRequest = parseSourceReleaseRequest({
      ...requestBase(target, target.roles['registry-verify'], 'registry-verify', 'release-operation-verify'),
      input: {
        artifact,
        artifactStatementDigest: signed.artifactStatementDigest,
        artifactSignature: signed.artifactSignature,
        registryReference,
        publishEvidenceDigest: reconciliationReceipt.evidenceDigest,
      },
    })
    const verifyResult = await invokePinnedAdapter(target, verifyRequest)
    verifyReceipt(verifyRequest, verifyResult, target.roles['registry-verify'])
    const verified = success(verifyResult)
    if (verified.kind !== 'registry-verify') throw new Error('missing registry verification evidence')
    const catalogRevision = verifyRequest.plan.revision + 1
    const downloadRecord = JSON.parse(await readFile(join(
      target.roles['registry-verify'].directory,
      'state',
      'operations',
      digestBytes(verifyRequest.operationId),
      'download.json',
    ), 'utf8')) as { destination: string }
    expect(downloadRecord.destination).toContain(target.downloadRoot)
    expect((await stat(downloadRecord.destination)).ino).not.toBe((await stat(new URL(registryReference))).ino)
    expect(`sha512-${createHash('sha512').update(await readFile(downloadRecord.destination)).digest('base64')}`).toBe(artifact.tarballIntegrity)

    const candidate = {
      id: artifact.candidateId,
      package: artifact.packageName,
      version: artifact.packageVersion,
      integrity: artifact.tarballIntegrity,
      registry: { id: verifyRequest.registry.id, locator: verifyRequest.registry.locator, reference: registryReference },
      requires: artifact.requires,
      dshBaseline: artifact.dshBaseline,
      capabilities: artifact.capabilities,
      authorities: artifact.authorities,
    }
    const preview = previewCatalogAdmission(JSON.parse(await readFile(target.catalogPath, 'utf8')), candidate)
    const catalogRequest = parseSourceReleaseRequest({
      ...requestBase(target, target.roles['catalog-admission'], 'catalog-admission', 'release-operation-catalog'),
      plan: { ...verifyRequest.plan, revision: catalogRevision },
      input: {
        artifact,
        artifactStatementDigest: signed.artifactStatementDigest,
        artifactSignature: signed.artifactSignature,
        registryReference,
        registryVerificationRequest: verifyRequest,
        registryVerificationReceipt: verifyResult,
        verificationEvidenceDigest: verifyResult.evidenceDigest,
        expectedBeforeCatalogDigest: preview.beforeCatalogDigest,
        expectedAfterCatalogDigest: preview.afterCatalogDigest,
        candidate,
      },
    })
    const catalogBefore = await readFile(target.catalogPath, 'utf8')
    const forgedSignature = Buffer.from(verifyResult.signature, 'base64')
    forgedSignature[0] ^= 1
    await expect(runAdapter(target, { ...catalogRequest, operationId: 'release-operation-catalog-forged-signature', input: {
      ...catalogRequest.input, registryVerificationReceipt: { ...verifyResult, signature: forgedSignature.toString('base64') },
    } })).rejects.toThrow('registry verification receipt signature or evidence digest is invalid')
    expect(await readFile(target.catalogPath, 'utf8')).toBe(catalogBefore)

    const wrongVerifier = generateKeyPairSync('ed25519')
    await expect(runAdapter(target, { ...catalogRequest, operationId: 'release-operation-catalog-wrong-verifier', input: {
      ...catalogRequest.input, registryVerificationReceipt: resignReceipt({ ...verifyResult, authority: 'wrong-registry-verifier',
        keyId: 'wrong-registry-key' }, wrongVerifier.privateKey),
    } })).rejects.toThrow('untrusted verifier identity')
    expect(await readFile(target.catalogPath, 'utf8')).toBe(catalogBefore)

    const tamperedEvidence = { ...verifyResult.evidence, publishEvidenceDigest: 'f'.repeat(64) }
    if (tamperedEvidence.kind !== 'registry-verify') throw new Error('missing registry verification evidence')
    const tamperedReceipt = resignReceipt({ ...verifyResult, evidence: tamperedEvidence,
      evidenceDigest: controlPlaneDigest(tamperedEvidence) }, wrongVerifier.privateKey)
    await expect(runAdapter(target, { ...catalogRequest, operationId: 'release-operation-catalog-tampered-evidence', input: {
      ...catalogRequest.input, registryVerificationReceipt: tamperedReceipt, verificationEvidenceDigest: tamperedReceipt.evidenceDigest,
    } })).rejects.toThrow('registry verification receipt signature or evidence digest is invalid')
    expect(await readFile(target.catalogPath, 'utf8')).toBe(catalogBefore)

    const wrongFence = resignReceipt({ ...verifyResult, fence: verifyResult.fence + 1 }, target.roles['registry-verify'].privateKey)
    await expect(runAdapter(target, { ...catalogRequest, operationId: 'release-operation-catalog-wrong-fence', input: {
      ...catalogRequest.input, registryVerificationReceipt: wrongFence,
    } })).rejects.toThrow('not bound to this catalog request')
    expect(await readFile(target.catalogPath, 'utf8')).toBe(catalogBefore)

    const tamperedRegistryRequest = { ...verifyRequest, input: { ...verifyRequest.input, publishEvidenceDigest: 'e'.repeat(64) } }
    await expect(runAdapter(target, { ...catalogRequest, operationId: 'release-operation-catalog-request-tamper', input: {
      ...catalogRequest.input, registryVerificationRequest: tamperedRegistryRequest,
    } })).rejects.toThrow('not bound to this catalog request')
    expect(await readFile(target.catalogPath, 'utf8')).toBe(catalogBefore)

    const invalidInterval = resignReceipt({ ...verifyResult, observedAt: verifyRequest.requestedAt - 1 },
      target.roles['registry-verify'].privateKey)
    await expect(runAdapter(target, { ...catalogRequest, operationId: 'release-operation-catalog-invalid-interval', input: {
      ...catalogRequest.input, registryVerificationReceipt: invalidInterval,
    } })).rejects.toThrow('invalid or expired')
    expect(await readFile(target.catalogPath, 'utf8')).toBe(catalogBefore)

    const catalogReceipt = await runAdapter(target, catalogRequest)
    verifyReceipt(catalogRequest, catalogReceipt, target.roles['catalog-admission'])
    expect(success(catalogReceipt)).toMatchObject({
      kind: 'catalog-admission',
      beforeCatalogDigest: preview.beforeCatalogDigest,
      afterCatalogDigest: preview.afterCatalogDigest,
      candidate,
    })
    expect((JSON.parse(await readFile(target.catalogPath, 'utf8')) as { entries: unknown[] }).entries).toEqual([candidate])

    const firstInvocations = await Promise.all(Object.values(target.roles).map(async role => {
      const names = (await readdir(join(role.directory, 'state', 'invocations'))).sort()
      const invocation = JSON.parse(await readFile(join(role.directory, 'state', 'invocations', names[0]!), 'utf8')) as {
        phase: SourceReleasePhase; pid: number; executable: string; authority: string; keyId: string
      }
      expect(invocation).toMatchObject({ phase: role.phase, executable: role.executable, authority: role.identity.authority, keyId: role.identity.keyId })
      return invocation.pid
    }))
    expect(new Set(firstInvocations).size).toBe(8)
  }, 60_000)

  test('executes retained tool and helper descriptors when their configured pathnames are swapped', async () => {
    const target = await createFixture(); const marker = join(target.root, 'evil-marker')
    const fixtureTool = join(target.root, 'true'); const retainedTool = fixtureTool + '.retained'; const evilTool = fixtureTool + '.evil'
    await copyFile('/usr/bin/true', fixtureTool); await chmod(fixtureTool, 0o700)
    await writeFile(evilTool, `#!${target.nodePath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'evil tool executed\n')\n`, { mode: 0o700 })
    const adapter = await import(pathToFileURL(adapterSource).href) as {
      runPinnedCommandForTest: (executable: { path: string; sha256: string }, args: string[], hooks: Record<string, () => void>) => string
      importPinnedHelperForTest: (interpreter: { path: string; sha256: string }, helper: { path: string; sha256: string },
        hooks: Record<string, () => void>) => string
    }
    let swappedTool = false
    expect(adapter.runPinnedCommandForTest({ path: fixtureTool, sha256: digestBytes(await readFile(fixtureTool)) }, [], {
      beforeSpawn: () => { renameSync(fixtureTool, retainedTool); renameSync(evilTool, fixtureTool); swappedTool = true },
      afterFinally: () => { if (swappedTool) { renameSync(fixtureTool, evilTool); renameSync(retainedTool, fixtureTool) } },
    })).toBe('')
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })

    const helperPath = join(target.roles['catalog-admission'].directory, '..', 'lib', 'catalog.js')
    const retainedHelper = helperPath.replace(/\.js$/u, '.retained.js'); const evilHelper = helperPath.replace(/\.js$/u, '.evil.js')
    await writeFile(evilHelper, `import { writeFileSync } from 'node:fs';writeFileSync(${JSON.stringify(marker)},'evil helper executed\n');
export async function admitCatalogCandidate(){throw new Error('evil')}
`, { mode: 0o600 })
    let swappedHelper = false
    expect(adapter.importPinnedHelperForTest(await executable(target.nodePath), { path: helperPath, sha256: digestBytes(await readFile(helperPath)) }, {
      beforeSpawn: () => { renameSync(helperPath, retainedHelper); renameSync(evilHelper, helperPath); swappedHelper = true },
      afterFinally: () => { if (swappedHelper) { renameSync(helperPath, evilHelper); renameSync(retainedHelper, helperPath) } },
    })).toBe('ok\n')
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  test('rejects forged authorization and symlinked state subdirectories before side effects', async () => {
    const forged = await createFixture()
    const forgedRequest = parseSourceReleaseRequest({ ...requestBase(forged, forged.roles.pr, 'pr', 'release-operation-forged'), input: {
      repository: forged.source, worktree: forged.worktree, baseCommit: forged.baseCommit, name: 'fixture-capability', scope: forged.scope,
      expectedTreeDigest: forged.treeDigest, expectedPatchDigest: forged.patchDigest } })
    const replacement = generateKeyPairSync('ed25519')
    const { signature: _signature, signatureDigest: _signatureDigest, ...unsigned } = forgedRequest.authorization
    const signature = sign(null, Buffer.from(sourceReleaseAuthorizationSigningPayload(unsigned)), replacement.privateKey).toString('base64')
    await expect(runAdapter(forged, { ...forgedRequest, authorization: { ...unsigned, signature,
      signatureDigest: digestBytes(Buffer.from(signature, 'base64')) } })).rejects.toThrow('authorization signature is invalid')
    expect(git(['--git-dir', forged.remote, 'show-ref', '--heads'])).toBe(forged.baseCommit + ' refs/heads/main')

    const escaped = await createFixture(); const stateRoot = join(escaped.roles.pr.directory, 'state')
    const outside = join(escaped.root, 'outside'); await mkdir(outside, { mode: 0o700 })
    await symlink(outside, join(stateRoot, 'operations'))
    const escapedRequest = parseSourceReleaseRequest({ ...requestBase(escaped, escaped.roles.pr, 'pr', 'release-operation-symlink'), input: {
      repository: escaped.source, worktree: escaped.worktree, baseCommit: escaped.baseCommit, name: 'fixture-capability', scope: escaped.scope,
      expectedTreeDigest: escaped.treeDigest, expectedPatchDigest: escaped.patchDigest } })
    await expect(runAdapter(escaped, escapedRequest)).rejects.toThrow('owner-private canonical directory')
    expect(await readdir(outside)).toEqual([])
  }, 30_000)
})
