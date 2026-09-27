import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Ed25519SourceReleaseAuthority } from './release.js'
import { runLocalCommand } from './source-workspace.js'
import { controlPlaneDigest } from './store.js'
import { resolveTrustKey, type PluginControlTrustConfig } from './trust.js'
import { sourceBaselineChain, verifySourceMaintenanceRecords,
  type SourceMaintenanceRecord } from './source-maintenance.js'
import type { PluginSourcePlan, SourceReleaseOperation } from './types.js'

const COMMIT = /^[a-f0-9]{40}$/u
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const ZERO = '0'.repeat(40)
const gitOptions = ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
  '-c', 'gc.auto=0', '-c', 'fetch.writeCommitGraph=false'] as const

export interface SourceBaselineConfig {
  ref: string
  remote: string
  targetBranch: string
  initialCommit: string
}

export function validateSourceBaselineConfig(value: unknown): asserts value is SourceBaselineConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('source baseline config must be an object')
  const item = value as Record<string, unknown>
  const name = typeof item.ref === 'string' ? item.ref.slice('refs/dsh-source/'.length) : ''
  if (Object.keys(item).sort().join('\0') !== ['ref', 'remote', 'targetBranch', 'initialCommit'].sort().join('\0')
    || typeof item.ref !== 'string' || item.ref !== `refs/dsh-source/${name}` || name.length > 64 || !NAME.test(name)
    || typeof item.remote !== 'string' || !isAbsolute(item.remote) || resolve(item.remote) !== item.remote
    || typeof item.targetBranch !== 'string' || item.targetBranch.length > 64 || !NAME.test(item.targetBranch)
    || typeof item.initialCommit !== 'string' || !COMMIT.test(item.initialCommit)) {
    throw new Error('source baseline config is invalid')
  }
}

function gitEnvironment(_environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Do not inherit GIT_CONFIG_*, Git directory/worktree overrides, hooks,
  // URL/protocol helpers, or credential variables from the caller.
  return { LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_ALLOW_PROTOCOL: 'file',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
    GIT_LFS_SKIP_SMUDGE: '1' }
}

async function git(args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  return (await runLocalCommand('git', [...gitOptions, ...args], cwd, environment,
    { capture: true, maximumOutput: 16_384, timeoutMs: 30_000, signal })).trimEnd()
}

async function directRef(cwd: string, ref: string, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string | undefined> {
  const output = await git(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', ref], cwd, environment, signal)
  if (output === '') return undefined
  const lines = output.split('\n')
  if (lines.length !== 1) throw new Error('source baseline ref has unexpected children')
  const fields = lines[0]!.split('\0')
  if (fields.length !== 3 || fields[0] !== ref || !COMMIT.test(fields[1]!) || fields[2] !== '') {
    throw new Error('source baseline ref is symbolic or malformed')
  }
  return fields[1]
}

async function canonicalRepository(repository: string, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  if (!isAbsolute(repository) || resolve(repository) !== repository || await realpath(repository) !== repository) {
    throw new Error('source baseline repository is not canonical')
  }
  if (await git(['rev-parse', '--show-toplevel'], repository, environment, signal) !== repository
    || await git(['rev-parse', '--is-bare-repository'], repository, environment, signal) !== 'false'
    || await git(['rev-parse', '--show-object-format=storage'], repository, environment, signal) !== 'sha1') {
    throw new Error('source baseline repository is not a SHA-1 top-level worktree')
  }
}

/** Fail closed if any main or linked worktree would follow the managed ref. */
async function assertNoCheckedOutManagedRef(repository: string, managedRef: string,
  environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  const listing = await git(['worktree', 'list', '--porcelain', '-z'], repository, environment, signal)
  if (!listing.endsWith('\0\0')) throw new Error('source baseline worktree listing is malformed')
  const records = listing.slice(0, -2).split('\0\0')
  if (records.length < 1 || records.length > 128) throw new Error('source baseline worktree count is outside bound')
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repository, environment, signal)
  const seen = new Set<string>()
  for (const record of records) {
    signal.throwIfAborted()
    const fields = record.split('\0')
    if (fields.length < 3 || fields.length > 4 || !fields[0]?.startsWith('worktree ')
      || !fields[1]?.startsWith('HEAD ') || !COMMIT.test(fields[1].slice(5))) {
      throw new Error('source baseline worktree listing has malformed records')
    }
    const path = fields[0].slice('worktree '.length), state = fields[2]!
    if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path || seen.has(path)
      || (fields[3] !== undefined && !fields[3].startsWith('locked '))) {
      throw new Error('source baseline worktree path or state is unsafe')
    }
    seen.add(path)
    if (await git(['rev-parse', '--show-toplevel'], path, environment, signal) !== path
      || await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], path, environment, signal) !== common) {
      throw new Error('source baseline worktree changed identity')
    }
    if (state.startsWith('branch ')) {
      const listed = state.slice('branch '.length)
      if (!listed.startsWith('refs/') || listed.includes('\n') || listed.includes('\0')) {
        throw new Error('source baseline worktree branch is malformed')
      }
      const resolved = await git(['symbolic-ref', 'HEAD'], path, environment, signal)
      if (resolved !== listed) throw new Error('source baseline worktree HEAD changed during inspection')
      if (resolved === managedRef) throw new Error('source baseline managed ref is checked out by a worktree')
    } else if (state === 'detached') {
      if (await git(['rev-parse', '--symbolic-full-name', 'HEAD'], path, environment, signal) !== 'HEAD') {
        throw new Error('source baseline detached worktree HEAD changed during inspection')
      }
    } else throw new Error('source baseline worktree state is unsafe')
  }
  if (!seen.has(repository)) throw new Error('source baseline repository is missing from its worktree list')
}

async function canonicalBareRemote(remote: string, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  if (await realpath(remote) !== remote) throw new Error('source baseline remote is not canonical')
  const stat = await lstat(remote, { bigint: true }), uid = process.getuid?.()
  if (!stat.isDirectory() || (stat.mode & 0o077n) !== 0n
    || (uid !== undefined && stat.uid !== 0n && stat.uid !== BigInt(uid))) {
    throw new Error('source baseline remote is not a private directory')
  }
  for (const forbidden of ['objects/info/alternates', 'objects/info/http-alternates']) {
    try { await lstat(join(remote, forbidden)); throw new Error('source baseline remote has external object alternates') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  if (await git(['rev-parse', '--is-bare-repository'], remote, environment, signal) !== 'true'
    || await git(['rev-parse', '--show-object-format=storage'], remote, environment, signal) !== 'sha1') {
    throw new Error('source baseline remote is not a SHA-1 bare repository')
  }
}

async function trustedChain(input: { repository: string; config: SourceBaselineConfig; trust: PluginControlTrustConfig;
  history: readonly { plan: PluginSourcePlan; operation: SourceReleaseOperation }[];
  maintenance: readonly SourceMaintenanceRecord[]; signal: AbortSignal }): Promise<readonly string[]> {
  const { repository, config, trust, history, maintenance } = input
  if (history.length > 1024) throw new Error('source baseline release history exceeds bound')
  for (const { plan, operation } of history) {
    input.signal.throwIfAborted()
    const request = operation.request, receipt = operation.receipt
    if (plan.status !== 'release-complete' || plan.repository !== repository || plan.release?.id !== request.release.id
      || plan.release.fence !== request.release.fence || operation.status !== 'applied' || operation.phase !== 'merge'
      || request.phase !== 'merge' || !receipt || receipt.phase !== 'merge' || receipt.outcome !== 'passed'
      || receipt.evidence.kind !== 'merge' || operation.planId !== plan.id || operation.operationId !== request.operationId
      || operation.requestDigest !== receipt.requestDigest || operation.fence !== request.release.fence
      || request.plan.id !== plan.id || request.plan.digest !== plan.digest || request.plan.revision > plan.revision
      || request.installationId !== trust.installationId || controlPlaneDigest(request.ledger) !== controlPlaneDigest(trust.ledger)
      || request.requestedAt !== operation.createdAt || !Number.isSafeInteger(operation.completedAt)
      || !Number.isSafeInteger(operation.appliedAt) || operation.completedAt! < receipt.observedAt
      || operation.appliedAt! < operation.completedAt!
      || request.input.targetBranch !== config.targetBranch || receipt.evidence.targetBranch !== config.targetBranch
      || !COMMIT.test(plan.baseCommit) || !COMMIT.test(receipt.evidence.mergeCommit)) {
      throw new Error('source baseline history contains an unbound or incomplete merge')
    }
    const key = resolveTrustKey(trust, 'release', receipt.authority, receipt.keyId)
    const verifier = new Ed25519SourceReleaseAuthority(key.publicKeyPem, key.authority, key.keyId, () => receipt.observedAt)
    await verifier.verify(receipt, { ...plan, revision: request.plan.revision }, request)
  }
  if (maintenance.length) {
    const first = maintenance[0]!
    const key = resolveTrustKey(trust, 'host-attestation', first.authority, first.keyId)
    verifySourceMaintenanceRecords(maintenance, { installationId: trust.installationId, ledger: trust.ledger,
      repository, baseline: config, hostIdentity: key })
  }
  return sourceBaselineChain(config, history, maintenance)
}

/** Historical receipts are verified at their signed observation time. */
export async function verifySourceBaselineHistory(input: { repository: string; config: SourceBaselineConfig;
  trust: PluginControlTrustConfig; history: readonly { plan: PluginSourcePlan; operation: SourceReleaseOperation }[];
  maintenance: readonly SourceMaintenanceRecord[]; signal: AbortSignal }): Promise<readonly string[]> {
  return trustedChain(input)
}

/** Advance only an owner-pinned private Git ref; never touch HEAD, index, or worktree. */
export async function resolveSourceBaseline(input: { repository: string; config: SourceBaselineConfig;
  environment: NodeJS.ProcessEnv; signal: AbortSignal; assertCurrent: () => void | Promise<void>;
  readHistory: () => readonly { plan: PluginSourcePlan; operation: SourceReleaseOperation }[];
  readMaintenance?: () => readonly SourceMaintenanceRecord[];
  trust: PluginControlTrustConfig }): Promise<string> {
  validateSourceBaselineConfig(input.config)
  const { repository, config } = input, signal = AbortSignal.any([input.signal, AbortSignal.timeout(30_000)])
  const environment = gitEnvironment(input.environment)
  const current = async (): Promise<void> => {
    signal.throwIfAborted()
    await new Promise<void>((resolvePromise, reject) => {
      const cancel = () => reject(signal.reason)
      signal.addEventListener('abort', cancel, { once: true })
      Promise.resolve().then(input.assertCurrent).then(() => {
        signal.removeEventListener('abort', cancel); resolvePromise()
      }, error => { signal.removeEventListener('abort', cancel); reject(error) })
    })
    signal.throwIfAborted()
  }
  await current()
  await canonicalRepository(repository, environment, signal)
  await canonicalBareRemote(config.remote, environment, signal)
  const history = input.readHistory(), maintenance = input.readMaintenance?.() ?? []
  const historyDigest = controlPlaneDigest({ history, maintenance })
  const trustDigest = controlPlaneDigest(input.trust)
  const chain = await trustedChain({ repository, config, trust: input.trust, history, maintenance, signal })
  const final = chain.at(-1)!
  const remoteRef = `refs/heads/${config.targetBranch}`
  const verifyState = async (): Promise<void> => {
    await current()
    if (controlPlaneDigest({ history: input.readHistory(), maintenance: input.readMaintenance?.() ?? [] }) !== historyDigest
      || controlPlaneDigest(input.trust) !== trustDigest) {
      throw new Error('source baseline authority changed during synchronization')
    }
    await canonicalRepository(repository, environment, signal)
    await assertNoCheckedOutManagedRef(repository, config.ref, environment, signal)
    await canonicalBareRemote(config.remote, environment, signal)
    if (await directRef(config.remote, remoteRef, environment, signal) !== final) {
      throw new Error('source baseline bare branch does not match signed release history')
    }
  }
  await verifyState()
  let present = await directRef(repository, config.ref, environment, signal)
  if (present !== undefined && !chain.includes(present)) throw new Error('source baseline managed ref diverged from signed history')
  // An explicit SHA fetch imports only the known target object; it never
  // writes FETCH_HEAD, tags, tracking refs, HEAD, the index, or the worktree.
  await git(['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--no-auto-gc',
    config.remote, final], repository, environment, signal)
  if (await git(['cat-file', '-t', final], repository, environment, signal) !== 'commit') {
    throw new Error('source baseline target object is not a commit')
  }
  for (let index = 0; index < chain.length - 1; index++) {
    await git(['merge-base', '--is-ancestor', chain[index]!, chain[index + 1]!], repository, environment, signal)
  }
  await verifyState()
  for (let index = present === undefined ? 0 : chain.indexOf(present) + 1; index < chain.length; index++) {
    const target = chain[index]!, expected = index === 0 ? ZERO : chain[index - 1]!
    await verifyState()
    if (await directRef(repository, config.ref, environment, signal) !== (index === 0 ? undefined : expected)) {
      if (await directRef(repository, config.ref, environment, signal) === final) break
      throw new Error('source baseline managed ref changed before CAS')
    }
    await assertNoCheckedOutManagedRef(repository, config.ref, environment, signal)
    try { await git(['update-ref', '--no-deref', '-m', 'dsh signed source baseline', config.ref, target, expected], repository, environment, signal) }
    catch (error) {
      if (await directRef(repository, config.ref, environment, signal) !== final) throw error
      break
    }
    present = target
    await verifyState()
  }
  await verifyState()
  if (await directRef(repository, config.ref, environment, signal) !== final) {
    throw new Error('source baseline managed ref did not reach signed target')
  }
  return final
}
