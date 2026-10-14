import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const OFFICIAL = 'https://github.com/22-ai-00/dsh-enhanced.git'
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u
const COMMIT = /^[a-f0-9]{40}$/u
const ZERO = '0'.repeat(40)
const MAX_OUTPUT = 65_536
const LEGACY_MAC_VERSION = '0.1.49'
const LEGACY_MAC_COMMIT = '172bc31ddf0c00a6f0b3252354f2170a14dd7fc2'
const GIT_FLAGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always', '-c', 'protocol.file.allow=always',
  '-c', 'credential.helper=', '-c', 'gc.auto=0'] as const

export interface RsiSourceWorkspace {
  schemaVersion: 1
  version: string
  origin: { kind: 'official-tag' | 'local-head'; locator: string; ref: string }
  sourceCommit: string
  repository: string
  baseline: { ref: 'refs/dsh-source/repairs'; remote: string; targetBranch: 'repairs'; initialCommit: string }
}

interface Receipt extends RsiSourceWorkspace {
  dshHome: string
  profile: string
  staticFiles: { checkoutConfig: string; checkoutHead: string; bareConfig: string; bareHead: string }
  receiptDigest: string
}

function fail(message: string): never { throw new Error(`rsi source: ${message}`) }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function canonicalPath(value: string, label: string): void {
  if (!isAbsolute(value) || resolve(value) !== value || value.includes('\0')) fail(`${label} must be canonical absolute`)
}
async function privateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.mode & 0o077
    || process.getuid && metadata.uid !== process.getuid() || await realpath(path) !== path) fail(`unsafe private directory: ${path}`)
}
async function safeHome(path: string): Promise<void> {
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.mode & 0o022
    || process.getuid && metadata.uid !== process.getuid() || await realpath(path) !== path) fail(`unsafe DSH_HOME: ${path}`)
}
async function syncDirectory(path: string): Promise<void> {
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await fd.sync() } finally { await fd.close() }
}
async function writeExclusive(path: string, bytes: string): Promise<void> {
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await fd.writeFile(bytes); await fd.sync() } finally { await fd.close() }
}
async function readStable(path: string, maximum: number, ownerPrivate: boolean): Promise<Buffer> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await fd.stat()
    if (!before.isFile() || before.size > maximum || ownerPrivate && (before.mode & 0o077)
      || process.getuid && before.uid !== process.getuid()) fail(`unsafe source file: ${path}`)
    const bytes = await fd.readFile()
    const after = await fd.stat(), name = await lstat(path)
    if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || name.dev !== before.dev || name.ino !== before.ino || name.isSymbolicLink()) fail(`source file changed during read: ${path}`)
    return bytes
  } finally { await fd.close() }
}
async function fileDigest(path: string): Promise<string> {
  return createHash('sha256').update(await readStable(path, 65_536, true)).digest('hex')
}
async function staticFiles(repository: string, remote: string): Promise<Receipt['staticFiles']> {
  return { checkoutConfig: await fileDigest(join(repository, '.git', 'config')),
    checkoutHead: await fileDigest(join(repository, '.git', 'HEAD')),
    bareConfig: await fileDigest(join(remote, 'config')),
    bareHead: await fileDigest(join(remote, 'HEAD')) }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: '/nonexistent',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_COUNT: '0', GIT_ALLOW_PROTOCOL: 'https:file', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', GCM_INTERACTIVE: 'never',
    GIT_LFS_SKIP_SMUDGE: '1', GIT_NO_LAZY_FETCH: '1' }
  // A fixed HTTPS upstream still needs the caller's ordinary corporate proxy
  // and CA routing. Do not pass arbitrary Git configuration or credential hooks.
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy',
    'NO_PROXY', 'no_proxy', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE']) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  return environment
}

/** Every Git invocation is bounded and receives only fixed argv and a minimal environment. */
async function git(cwd: string, args: readonly string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
  return new Promise<string>((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn>
    try { child = spawn('/usr/bin/git', [...GIT_FLAGS, ...args], { cwd, env: gitEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true }) }
    catch { reject(new Error('rsi source: Git invocation failed')); return }
    const chunks: Buffer[] = []
    let size = 0, overLimit = false, spawnError = false
    const terminate = () => {
      if (!child.pid) return
      try {
        if (process.platform === 'win32') child.kill('SIGKILL')
        else process.kill(-child.pid, 'SIGKILL')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL') }
    }
    const abort = () => terminate()
    bounded.addEventListener('abort', abort, { once: true })
    if (bounded.aborted) terminate()
    const collect = (data: Buffer) => {
      size += data.length
      if (size > MAX_OUTPUT) { overLimit = true; terminate(); return }
      chunks.push(data)
    }
    child.stdout!.on('data', collect); child.stderr!.on('data', collect)
    child.once('error', () => { spawnError = true; terminate() })
    child.once('close', (code, killed) => {
      bounded.removeEventListener('abort', abort)
      if (spawnError || overLimit || code !== 0 || killed !== null || bounded.aborted) reject(new Error('rsi source: Git command failed, timed out, or exceeded output limit'))
      else resolvePromise(Buffer.concat(chunks).toString('utf8').trim())
    })
  })
}

async function ref(repository: string, name: string, signal: AbortSignal): Promise<string | undefined> {
  const output = await git(repository, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', name], signal)
  if (output === '') return undefined
  const fields = output.split('\0')
  if (fields.length !== 3 || fields[0] !== name || !COMMIT.test(fields[1]!) || fields[2] !== '') fail(`malformed or symbolic Git ref ${name}`)
  return fields[1]
}

async function validateSource(repository: string, version: string, commit: string, signal: AbortSignal): Promise<void> {
  if (!COMMIT.test(commit) || await git(repository, ['cat-file', '-t', commit], signal) !== 'commit') fail('source is not a SHA-1 commit')
  const file = join(repository, 'package.json')
  const value = JSON.parse((await readStable(file, 1_048_576, false)).toString('utf8')) as Record<string, unknown>
  if (value.name !== 'dsh-enhanced' || value.version !== version) fail('source package name/version differs from installed cohort')
}

async function inspectWorkspace(value: RsiSourceWorkspace, signal: AbortSignal): Promise<void> {
  const repository = value.repository, remote = value.baseline.remote, commit = value.sourceCommit
  await privateDirectory(repository); await privateDirectory(remote)
  const gitDir = await lstat(join(repository, '.git'))
  if (!gitDir.isDirectory() || gitDir.isSymbolicLink() || gitDir.mode & 0o022
    || await realpath(join(repository, '.git')) !== join(repository, '.git')) fail('checkout Git directory changed identity')
  if (await git(repository, ['rev-parse', '--show-toplevel'], signal) !== repository
    || await git(repository, ['rev-parse', '--is-bare-repository'], signal) !== 'false'
    || await git(repository, ['rev-parse', '--show-object-format=storage'], signal) !== 'sha1'
    || await git(repository, ['rev-parse', 'HEAD'], signal) !== commit
    || await git(repository, ['symbolic-ref', 'HEAD'], signal) !== 'refs/heads/repairs'
    || await ref(repository, 'refs/heads/repairs', signal) !== commit
    || await git(repository, ['status', '--porcelain=v1', '--untracked-files=all'], signal) !== '') fail('checkout provenance or cleanliness changed')
  await validateSource(repository, value.version, commit, signal)
  if (await git(remote, ['rev-parse', '--is-bare-repository'], signal) !== 'true'
    || await git(remote, ['rev-parse', '--show-object-format=storage'], signal) !== 'sha1'
    || await git(remote, ['symbolic-ref', 'HEAD'], signal) !== 'refs/heads/repairs') fail('release repository changed identity')
  for (const path of [join(repository, '.git', 'objects', 'info', 'alternates'), join(remote, 'objects', 'info', 'alternates')]) {
    try { await lstat(path); fail('external Git object alternates are forbidden') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  for (const [location, name] of [[repository, value.baseline.ref], [remote, 'refs/heads/repairs']] as const) {
    const current = await ref(location, name, signal)
    if (!current || await git(location, ['cat-file', '-t', current], signal) !== 'commit') fail('managed release ref is missing')
    await git(location, ['merge-base', '--is-ancestor', commit, current], signal)
  }
}

async function existing(path: string, expected: Omit<Receipt, 'sourceCommit' | 'receiptDigest' | 'baseline' | 'staticFiles'> & { baseline: Omit<RsiSourceWorkspace['baseline'], 'initialCommit'> }, signal: AbortSignal): Promise<RsiSourceWorkspace> {
  await privateDirectory(path)
  const names = (await readdir(path)).sort()
  if (JSON.stringify(names) !== JSON.stringify(['bootstrap.json', 'checkout', 'release.git'])) fail('workspace has unexpected or incomplete contents')
  const receiptPath = join(path, 'bootstrap.json')
  const value = JSON.parse((await readStable(receiptPath, 16_384, true)).toString('utf8')) as Receipt
  const { receiptDigest, ...content } = value
  if (Object.keys(value).sort().join('\0') !== ['schemaVersion', 'version', 'origin', 'sourceCommit', 'repository', 'baseline', 'dshHome', 'profile', 'staticFiles', 'receiptDigest'].sort().join('\0')
    || value.schemaVersion !== 1 || !COMMIT.test(value.sourceCommit) || digest(content) !== receiptDigest
    || value.dshHome !== expected.dshHome || value.profile !== expected.profile || value.version !== expected.version
    || JSON.stringify(value.origin) !== JSON.stringify(expected.origin)
    || value.repository !== expected.repository || value.baseline?.ref !== expected.baseline.ref
    || value.baseline?.remote !== expected.baseline.remote || value.baseline?.targetBranch !== expected.baseline.targetBranch
    || value.baseline?.initialCommit !== value.sourceCommit) fail('workspace receipt provenance differs from requested source')
  if (JSON.stringify(await staticFiles(value.repository, value.baseline.remote)) !== JSON.stringify(value.staticFiles)) fail('workspace static Git files changed')
  await inspectWorkspace(value, signal)
  const { dshHome: _home, profile: _profile, staticFiles: _files, receiptDigest: _digest, ...result } = value
  return result
}

async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error }
}

async function initialRefs(repository: string, expected: readonly string[], signal: AbortSignal): Promise<boolean> {
  const rows = (await git(repository, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)'], signal))
    .split('\n').filter(Boolean).sort()
  return JSON.stringify(rows) === JSON.stringify(expected.map(name => `${name}\0${LEGACY_MAC_COMMIT}\0`).sort())
}

/** Retire only the verified official 0.1.49 Mac source preparation.
 * No prepared grant, build or coordinator resource or noninitial ref may exist.
 * The old tree is retained byte-for-byte with its original receipt paths. */
async function archiveUnusedLegacyMacWorkspace(home: string, profile: string,
  old: RsiSourceWorkspace, signal: AbortSignal): Promise<string> {
  if (old.version !== LEGACY_MAC_VERSION || old.origin.kind !== 'official-tag'
    || old.origin.locator !== OFFICIAL || old.origin.ref !== 'refs/tags/v0.1.49'
    || old.sourceCommit !== LEGACY_MAC_COMMIT || old.baseline.initialCommit !== LEGACY_MAC_COMMIT
    || !await initialRefs(old.repository, ['refs/dsh-source/repairs', 'refs/heads/repairs'], signal)
    || !await initialRefs(old.baseline.remote, ['refs/heads/repairs'], signal)) {
    fail('legacy Mac source has maintenance or unknown Git refs; preserve it and resolve the existing source authority manually')
  }
  const resourcePaths = [
    ...['rsi-authorities', 'rsi-authority-runtimes', 'rsi-builds', 'rsi-creation-builds',
      'rsi-release-builds', 'rsi-local-cohorts'].map(kind => join(home, kind, profile)),
    join(home, 'rsi-service-environments', `${profile}.json`),
    join(home, 'rsi-coordinators'), join(home, '.rsi-setup-journal.json'),
    join(home, '.rsi-systemd-capture-journal.json'),
    join(home, `.rsi-coordinator-${createHash('sha256').update(profile).digest('hex').slice(0, 16)}.json`),
    join(home, `.rsi-${createHash('sha256').update(profile).digest('hex').slice(0, 12)}`),
    join(dirname(home), `.dsh-rsi-local-updates-${createHash('sha256').update(home).digest('hex').slice(0, 16)}`),
  ]
  for (const path of resourcePaths) if (!await absent(path)) {
    fail(`legacy Mac source may already have prepared or active RSI resources at ${path}; preserve its authority and resolve manually`)
  }
  for (const kind of ['rsi-sources', 'rsi-authority-runtimes', 'rsi-builds', 'rsi-creation-builds',
    'rsi-release-builds', 'rsi-local-cohorts']) {
    const parent = join(home, kind)
    if (await absent(parent)) continue
    const names = await readdir(parent)
    if (names.some(name => name.startsWith(`.${profile}-stage-`)
      || name.startsWith(`.${profile}-update-`) || name.startsWith(`.${profile}-previous-`))) {
      fail(`legacy Mac source has unfinished RSI preparation in ${parent}; preserve it and resolve manually`)
    }
  }
  if ((await readdir(home)).some(name => name.startsWith('.rsi-coordinator-'))) {
    fail('legacy Mac source has a coordinator marker; preserve its authority and resolve manually')
  }
  // A previous successful migration is not a license to rebase again. An
  // interrupted attempt may have created only the empty private archive slot.
  const archiveParent = join(home, 'rsi-source-archives')
  try { await mkdir(archiveParent, { mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  await privateDirectory(archiveParent)
  if ((await lstat(archiveParent)).uid !== process.getuid?.()) fail('legacy archive parent is not owned by the current user')
  const profileArchive = join(archiveParent, profile)
  try { await mkdir(profileArchive, { mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  await privateDirectory(profileArchive)
  if ((await lstat(profileArchive)).uid !== process.getuid?.()) fail('legacy archive slot is not owned by the current user')
  if ((await readdir(profileArchive)).length !== 0) {
    fail('legacy Mac source has an existing archive; preserve both histories and resolve manually')
  }
  const destination = join(profileArchive, randomUUID())
  signal.throwIfAborted()
  let archived = false
  try {
    await rename(join(home, 'rsi-sources', profile), destination)
    archived = true
    await syncDirectory(profileArchive)
    await syncDirectory(join(home, 'rsi-sources'))
  } catch (error) {
    if (archived) throw new Error(`rsi source: legacy archive was moved to ${destination}; verify it before retrying`, { cause: error })
    throw error
  }
  return destination
}

/** Read the registered source without creating or repairing any workspace. */
export async function readRsiSourceWorkspace(input: { dshHome: string; profile: string; version?: string;
  sourceRepository?: string | undefined; signal?: AbortSignal }): Promise<RsiSourceWorkspace> {
  canonicalPath(input.dshHome, 'DSH_HOME')
  if (!PROFILE.test(input.profile) || input.version !== undefined && !VERSION.test(input.version)) fail('invalid profile or exact version')
  await safeHome(input.dshHome)
  const final = join(input.dshHome, 'rsi-sources', input.profile)
  await privateDirectory(join(input.dshHome, 'rsi-sources'))
  await privateDirectory(final)
  const receipt = JSON.parse((await readStable(join(final, 'bootstrap.json'), 16_384, true)).toString('utf8')) as Receipt
  if (!VERSION.test(receipt.version) || !receipt.origin || !['local-head', 'official-tag'].includes(receipt.origin.kind)) fail('source bootstrap identity is invalid')
  if (input.sourceRepository !== undefined) canonicalPath(input.sourceRepository, 'source repository')
  const origin: RsiSourceWorkspace['origin'] = input.sourceRepository === undefined ? receipt.origin
    : { kind: 'local-head', locator: input.sourceRepository, ref: 'HEAD' }
  if (origin.kind === 'local-head') canonicalPath(origin.locator, 'source repository')
  else if (origin.locator !== OFFICIAL || origin.ref !== `refs/tags/v${receipt.version}`) fail('official source identity differs')
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(180_000)])
  const expected = { schemaVersion: 1 as const, version: receipt.version, origin,
    repository: join(final, 'checkout'), dshHome: input.dshHome, profile: input.profile,
    baseline: { ref: 'refs/dsh-source/repairs' as const, remote: join(final, 'release.git'), targetBranch: 'repairs' as const } }
  let maintained = false
  try { await lstat(join(final, 'maintenance.json')); maintained = true }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const result = maintained
    ? (await (await import('./rsi-source-maintenance.js')).readRsiSourceMaintenance({
      logicalHome: input.dshHome, physicalHome: input.dshHome, profile: input.profile, signal })).workspace
    : await existing(final, expected, signal)
  if (JSON.stringify(result.origin) !== JSON.stringify(origin)
    || input.version !== undefined && result.version !== input.version) fail('effective source identity differs')
  return result
}

/** Caller must hold the DSH_HOME lifecycle lock across this operation and setup. */
export async function prepareRsiSourceWorkspace(input: { dshHome: string; profile: string; version: string;
  sourceRepository?: string | undefined; signal?: AbortSignal }): Promise<RsiSourceWorkspace> {
  canonicalPath(input.dshHome, 'DSH_HOME')
  if (!PROFILE.test(input.profile) || !VERSION.test(input.version)) fail('invalid profile or exact version')
  await safeHome(input.dshHome)
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(180_000)])
  let local: string | undefined
  if (input.sourceRepository !== undefined) {
    canonicalPath(input.sourceRepository, 'source repository')
    local = await realpath(input.sourceRepository)
    if (local !== input.sourceRepository || await git(local, ['rev-parse', '--show-toplevel'], signal) !== local
      || await git(local, ['rev-parse', '--is-bare-repository'], signal) !== 'false'
      || await git(local, ['rev-parse', '--show-object-format=storage'], signal) !== 'sha1') fail('local source is not a canonical SHA-1 checkout')
  }
  const parent = join(input.dshHome, 'rsi-sources')
  try { await mkdir(parent, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  await privateDirectory(parent)
  const final = join(parent, input.profile), repository = join(final, 'checkout'), remote = join(final, 'release.git')
  const origin: RsiSourceWorkspace['origin'] = local
    ? { kind: 'local-head', locator: local, ref: 'HEAD' }
    : { kind: 'official-tag', locator: OFFICIAL, ref: `refs/tags/v${input.version}` }
  const expected = { schemaVersion: 1 as const, version: input.version, origin, repository,
    dshHome: input.dshHome, profile: input.profile,
    baseline: { ref: 'refs/dsh-source/repairs' as const, remote, targetBranch: 'repairs' as const } }
  const present = await lstat(final).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  })
  if (present) {
    if (process.platform !== 'darwin') return readRsiSourceWorkspace({ ...input, signal })
    const old = await readRsiSourceWorkspace({ dshHome: input.dshHome, profile: input.profile, signal })
    if (old.version === input.version && (input.sourceRepository === undefined
      || JSON.stringify(old.origin) === JSON.stringify(origin))) return old
    const archive = await archiveUnusedLegacyMacWorkspace(input.dshHome, input.profile, old, signal)
    try { return await prepareRsiSourceWorkspace(input) }
    catch (error) {
      throw new Error(`rsi source: replacement preparation failed; untouched legacy source is retained at ${archive}`, { cause: error })
    }
  }
  const stage = await mkdtemp(join(parent, `.${input.profile}-stage-`))
  await chmod(stage, 0o700)
  let claimed = false, claimIdentity: { dev: number; ino: number } | undefined
  try {
    const checkout = join(stage, 'checkout'), bare = join(stage, 'release.git')
    await mkdir(checkout, { mode: 0o700 })
    await git(checkout, ['init', '--object-format=sha1', '--initial-branch=repairs', '.'], signal)
    let commit: string
    if (local) {
      commit = await git(local, ['rev-parse', 'HEAD'], signal)
      if (!COMMIT.test(commit)) fail('local source HEAD is not SHA-1')
      await git(checkout, ['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', local,
        `+${commit}:refs/dsh-bootstrap/source`], signal)
    } else {
      await git(checkout, ['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', OFFICIAL,
        `+refs/tags/v${input.version}:refs/dsh-bootstrap/source`], signal)
      commit = await git(checkout, ['rev-parse', 'refs/dsh-bootstrap/source^{commit}'], signal)
    }
    await git(checkout, ['switch', '--create', 'repairs', commit], signal)
    await git(checkout, ['update-ref', '--no-deref', 'refs/dsh-source/repairs', commit, ZERO], signal)
    await git(checkout, ['update-ref', '-d', 'refs/dsh-bootstrap/source'], signal)
    await validateSource(checkout, input.version, commit, signal)
    await git(stage, ['init', '--bare', '--object-format=sha1', '--initial-branch=repairs', bare], signal)
    await chmod(bare, 0o700)
    await git(bare, ['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', checkout,
      `+${commit}:refs/heads/repairs`], signal)
    for (const path of [join(checkout, '.git', 'config'), join(checkout, '.git', 'HEAD'),
      join(bare, 'config'), join(bare, 'HEAD')]) await chmod(path, 0o600)
    const value: RsiSourceWorkspace = { schemaVersion: 1, version: input.version, origin, sourceCommit: commit,
      repository, baseline: { ...expected.baseline, initialCommit: commit } }
    await mkdir(final, { mode: 0o700 }) // O_EXCL-like directory claim: never replace another owner's tree.
    claimed = true
    const identity = await stat(final); claimIdentity = { dev: identity.dev, ino: identity.ino }
    await rename(checkout, repository); await rename(bare, remote)
    await inspectWorkspace(value, signal)
    await syncDirectory(final)
    const content = { ...value, dshHome: input.dshHome, profile: input.profile,
      staticFiles: await staticFiles(repository, remote) }
    await writeExclusive(join(final, 'bootstrap.json'), JSON.stringify({ ...content, receiptDigest: digest(content) }))
    await syncDirectory(final); await syncDirectory(parent)
    return value
  } catch (error) {
    if (claimed && claimIdentity) {
      const current = await lstat(final).catch(() => undefined)
      if (current?.isDirectory() && current.dev === claimIdentity.dev && current.ino === claimIdentity.ino) {
        const names = await readdir(final).catch(() => [])
        if (names.every(name => ['checkout', 'release.git', 'bootstrap.json'].includes(name))) await rm(final, { recursive: true, force: true })
      }
    }
    throw error
  } finally { await rm(stage, { recursive: true, force: true }); await syncDirectory(parent) }
}
